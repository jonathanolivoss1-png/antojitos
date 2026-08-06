'use strict';

const crypto = require('crypto');
const pgPool = require('../postgres');

const COMPLETE_WINDOW_MS = 30 * 1000;
const PROCESSING_TTL_MS = 2 * 60 * 1000;
const memoryClaims = new Map();
let tableReadyPromise = null;

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        if (key !== 'requestId' && key !== 'idempotencyKey') {
          result[key] = stableValue(value[key]);
        }
        return result;
      }, {});
  }

  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function hash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value))
    .digest('hex');
}

function semanticOrderBody(body = {}) {
  const rawItems =
    Array.isArray(body.productos)
      ? body.productos
      : Array.isArray(body.items)
        ? body.items
        : [];

  const items = rawItems
    .map(item => ({
      qty:
        Number(
          item?.qty ??
          item?.cantidad ??
          1
        ),

      name:
        String(
          item?.name ??
          item?.nombre ??
          ''
        ),

      price:
        Number(
          item?.price ??
          item?.precio ??
          0
        ),

      kind:
        String(item?.kind || ''),

      productId:
        String(item?.productId || ''),

      optionId:
        String(item?.optionId || ''),

      choice:
        String(
          item?.choice ??
          item?.opcion ??
          item?.observaciones ??
          ''
        ),

      notes:
        String(item?.notes || '')
    }))
    .sort((left, right) =>
      stableStringify(left)
        .localeCompare(
          stableStringify(right)
        )
    );

  return {
    clienteToken:
      String(
        body.clienteToken ??
        body.clientToken ??
        ''
      ),

    cliente:
      String(
        body.cliente ??
        body.name ??
        ''
      ),

    telefono:
      String(
        body.telefono ??
        body.phone ??
        ''
      ),

    direccion:
      String(
        body.direccion ??
        body.address ??
        ''
      ),

    tipoEntrega:
      String(
        body.tipoEntrega ??
        body.deliveryType ??
        ''
      ),

    subtotal:
      Number(body.subtotal || 0),

    envio:
      Number(body.envio || 0),

    total:
      Number(body.total || 0),

    items
  };
}

function requestFingerprint(req, scope, principal) {
  return hash(
    [
      scope,
      String(principal || ''),
      req.method,
      stableStringify(
        semanticOrderBody(
          req.body || {}
        )
      )
    ].join('|')
  );
}

function requestKey(req, scope, fingerprint) {
  const supplied = String(
    req.get('X-Idempotency-Key') ||
    req.body?.requestId ||
    req.body?.idempotencyKey ||
    ''
  )
    .trim()
    .slice(0, 160);

  return supplied
    ? `${scope}:${hash(supplied)}`
    : `${scope}:${fingerprint}`;
}

async function ensureTable() {
  if (!pgPool) return;

  if (!tableReadyPromise) {
    tableReadyPromise = pgPool.query(`
      CREATE TABLE IF NOT EXISTS pedidos_idempotencia (
        clave TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        estado TEXT NOT NULL,
        status_code INTEGER,
        respuesta JSONB,
        creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_pedidos_idempotencia_fingerprint
        ON pedidos_idempotencia (
          scope,
          fingerprint,
          actualizado_en DESC
        );
    `).catch(error => {
      tableReadyPromise = null;
      throw error;
    });
  }

  await tableReadyPromise;
}

function cleanupMemory() {
  const now = Date.now();

  for (const [key, value] of memoryClaims.entries()) {
    if (now - value.updatedAt > PROCESSING_TTL_MS) {
      memoryClaims.delete(key);
    }
  }
}

async function claimPostgres({
  key,
  scope,
  fingerprint
}) {
  await ensureTable();

  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [`${scope}:${fingerprint}`]
    );

    const result = await client.query(
      `
        SELECT
          clave,
          estado,
          status_code,
          respuesta,
          actualizado_en
        FROM pedidos_idempotencia
        WHERE
          clave = $1
          OR (
            scope = $2
            AND fingerprint = $3
            AND actualizado_en >= NOW() - INTERVAL '30 seconds'
          )
        ORDER BY
          CASE WHEN clave = $1 THEN 0 ELSE 1 END,
          actualizado_en DESC
        LIMIT 1
      `,
      [key, scope, fingerprint]
    );

    const existing = result.rows[0];

    if (existing) {
      const ageMs =
        Date.now() -
        new Date(existing.actualizado_en).getTime();

      if (existing.estado === 'completado') {
        await client.query('COMMIT');

        return {
          action: 'replay',
          statusCode: Number(existing.status_code || 200),
          response: existing.respuesta || {
            ok: true,
            duplicate: true
          }
        };
      }

      if (
        existing.estado === 'procesando' &&
        ageMs < PROCESSING_TTL_MS
      ) {
        await client.query('COMMIT');

        return {
          action: 'processing'
        };
      }
    }

    await client.query(
      `
        INSERT INTO pedidos_idempotencia (
          clave,
          scope,
          fingerprint,
          estado,
          creado_en,
          actualizado_en
        )
        VALUES ($1, $2, $3, 'procesando', NOW(), NOW())
        ON CONFLICT (clave)
        DO UPDATE SET
          scope = EXCLUDED.scope,
          fingerprint = EXCLUDED.fingerprint,
          estado = 'procesando',
          status_code = NULL,
          respuesta = NULL,
          actualizado_en = NOW()
      `,
      [key, scope, fingerprint]
    );

    await client.query('COMMIT');

    return {
      action: 'continue'
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function claimMemory({
  key,
  scope,
  fingerprint
}) {
  cleanupMemory();

  const now = Date.now();

  const match = Array.from(memoryClaims.values())
    .find(value =>
      value.key === key ||
      (
        value.scope === scope &&
        value.fingerprint === fingerprint &&
        now - value.updatedAt <= COMPLETE_WINDOW_MS
      )
    );

  if (match?.state === 'completed') {
    return {
      action: 'replay',
      statusCode: match.statusCode,
      response: match.response
    };
  }

  if (
    match?.state === 'processing' &&
    now - match.updatedAt < PROCESSING_TTL_MS
  ) {
    return {
      action: 'processing'
    };
  }

  memoryClaims.set(key, {
    key,
    scope,
    fingerprint,
    state: 'processing',
    updatedAt: now
  });

  return {
    action: 'continue'
  };
}

async function completePostgres(
  key,
  statusCode,
  response
) {
  await pgPool.query(
    `
      UPDATE pedidos_idempotencia
      SET
        estado = 'completado',
        status_code = $2,
        respuesta = $3::jsonb,
        actualizado_en = NOW()
      WHERE clave = $1
    `,
    [
      key,
      statusCode,
      JSON.stringify(response ?? null)
    ]
  );
}

async function releasePostgres(key) {
  await pgPool.query(
    'DELETE FROM pedidos_idempotencia WHERE clave = $1',
    [key]
  );
}

function completeMemory(
  key,
  scope,
  fingerprint,
  statusCode,
  response
) {
  memoryClaims.set(key, {
    key,
    scope,
    fingerprint,
    state: 'completed',
    statusCode,
    response,
    updatedAt: Date.now()
  });
}

function releaseMemory(key) {
  memoryClaims.delete(key);
}

function createOrderIdempotency(options = {}) {
  const scope =
    String(options.scope || 'pedidos').trim() ||
    'pedidos';

  const principal =
    typeof options.principal === 'function'
      ? options.principal
      : req => req.ip || 'unknown';

  return async function orderIdempotency(
    req,
    res,
    next
  ) {
    if (req.method !== 'POST') {
      return next();
    }

    try {
      const principalValue = principal(req);
      const fingerprint =
        requestFingerprint(
          req,
          scope,
          principalValue
        );

      const key =
        requestKey(req, scope, fingerprint);

      const claim = pgPool
        ? await claimPostgres({
            key,
            scope,
            fingerprint
          })
        : claimMemory({
            key,
            scope,
            fingerprint
          });

      if (claim.action === 'replay') {
        const response = {
          ...(claim.response || {}),
          duplicate: true
        };

        return res
          .status(claim.statusCode || 200)
          .json(response);
      }

      if (claim.action === 'processing') {
        return res.status(409).json({
          ok: false,
          duplicate: true,
          processing: true,
          message:
            'Esta orden ya se está procesando. No la envíes nuevamente.'
        });
      }

      let finished = false;
      const originalJson = res.json.bind(res);

      res.json = function idempotentJson(body) {
        if (finished) {
          return originalJson(body);
        }

        finished = true;
        const statusCode = Number(res.statusCode || 200);
        const successful =
          statusCode >= 200 &&
          statusCode < 300;

        const finalize = pgPool
          ? (
              successful
                ? completePostgres(
                    key,
                    statusCode,
                    body
                  )
                : releasePostgres(key)
            )
          : Promise.resolve(
              successful
                ? completeMemory(
                    key,
                    scope,
                    fingerprint,
                    statusCode,
                    body
                  )
                : releaseMemory(key)
            );

        finalize
          .catch(error => {
            console.error(
              'No se pudo finalizar la protección contra duplicados:',
              error
            );
          })
          .finally(() => {
            originalJson(body);
          });

        return res;
      };

      res.on('close', () => {
        if (!finished && !res.writableEnded) {
          const release = pgPool
            ? releasePostgres(key)
            : Promise.resolve(releaseMemory(key));

          void release.catch(() => {});
        }
      });

      return next();
    } catch (error) {
      console.error(
        'Error en protección contra pedidos duplicados:',
        error
      );

      return next();
    }
  };
}

module.exports = {
  createOrderIdempotency,
  stableStringify,
  semanticOrderBody,
  requestFingerprint
};
