// PERSONAL_VISIBLE_NAMES_V1
// WAITER_MODULE_V1
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const pgPool = require('../postgres');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { broadcastAdminEvent } = require('../realtime/events');

const router = express.Router();
const usePostgres = Boolean(pgPool);
const PRODUCTS_KEY = 'site_products_v1';
const PROMOS_KEY = 'site_promotions_v1';

function sanitizeText(value, maxLength = 160) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizePlaceholders(sql) {
  if (!usePostgres) return String(sql);
  let index = 0;
  return String(sql).replace(/\?/g, () => `$${++index}`);
}

async function queryAll(sql, params = []) {
  if (usePostgres) {
    const result = await pgPool.query(
      normalizePlaceholders(sql),
      params
    );
    return result.rows;
  }

  return db.prepare(sql).all(...params);
}

async function queryOne(sql, params = []) {
  if (usePostgres) {
    const result = await pgPool.query(
      normalizePlaceholders(sql),
      params
    );
    return result.rows[0] || null;
  }

  return db.prepare(sql).get(...params) || null;
}

async function execute(sql, params = []) {
  if (usePostgres) {
    return pgPool.query(
      normalizePlaceholders(sql),
      params
    );
  }

  return db.prepare(sql).run(...params);
}

async function readConfigJson(key) {
  const row = await queryOne(
    'SELECT valor FROM configuracion WHERE clave = ? LIMIT 1',
    [key]
  );

  if (!row || row.valor == null) {
    return null;
  }

  if (
    usePostgres &&
    typeof row.valor !== 'string'
  ) {
    return row.valor;
  }

  try {
    return JSON.parse(row.valor);
  } catch {
    return null;
  }
}

async function initializeWaiterTables() {
  if (usePostgres) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS meseros_usuarios (
        id BIGSERIAL PRIMARY KEY,
        usuario VARCHAR(60) NOT NULL UNIQUE,
        nombre VARCHAR(120) NOT NULL,
        pin_hash TEXT NOT NULL,
        activo BOOLEAN NOT NULL DEFAULT TRUE,
        creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_meseros_usuarios_activo
        ON meseros_usuarios (activo);
    `);

    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS meseros_usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT NOT NULL UNIQUE,
      nombre TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      creado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actualizado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_meseros_usuarios_activo
      ON meseros_usuarios (activo);
  `);
}

let tablesError = null;
const tablesReady = initializeWaiterTables().catch(error => {
  tablesError = error;
  console.error(
    'No se pudo inicializar el módulo del personal:',
    error
  );
});

async function waitForTables() {
  await tablesReady;

  if (tablesError) {
    throw tablesError;
  }
}

async function requireWaiter(req, res, next) {
  try {
    await waitForTables();

    const waiter = req.session?.mesero;

    if (!waiter?.id) {
      return res.status(401).json({
        ok: false,
        message: 'Inicia sesión como personal'
      });
    }

    const row = await queryOne(
      `
        SELECT id, activo
        FROM meseros_usuarios
        WHERE id = ?
        LIMIT 1
      `,
      [waiter.id]
    );

    const active =
      row &&
      (
        row.activo === true ||
        row.activo === 1 ||
        row.activo === '1'
      );

    if (!active) {
      delete req.session.mesero;

      return req.session.save(() =>
        res.status(401).json({
          ok: false,
          message: 'Este acceso fue desactivado'
        })
      );
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

const attempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

function attemptKey(req, user) {
  return `${req.ip || 'unknown'}::${String(user).toLowerCase()}`;
}

function getAttemptState(key) {
  const now = Date.now();
  const current = attempts.get(key);

  if (!current) {
    return {
      count: 0,
      firstAt: now,
      lockedUntil: 0
    };
  }

  if (
    current.lockedUntil &&
    current.lockedUntil > now
  ) {
    return current;
  }

  if (now - current.firstAt > WINDOW_MS) {
    attempts.delete(key);

    return {
      count: 0,
      firstAt: now,
      lockedUntil: 0
    };
  }

  return current;
}

function recordFailedAttempt(key) {
  const now = Date.now();
  const state = getAttemptState(key);
  const count = state.count + 1;

  attempts.set(key, {
    count,
    firstAt: state.firstAt || now,
    lockedUntil:
      count >= MAX_ATTEMPTS
        ? now + LOCK_MS
        : 0
  });
}

function clearAttempts(key) {
  attempts.delete(key);
}

function isValidPin(pin) {
  return /^\d{4,12}$/.test(String(pin || ''));
}

function publicWaiter(row) {
  return {
    id: Number(row.id),
    usuario: String(row.usuario || ''),
    nombre: String(row.nombre || ''),
    activo:
      row.activo === true ||
      row.activo === 1 ||
      row.activo === '1'
  };
}

router.post('/login', async (req, res) => {
  try {
    await waitForTables();

    const usuario = sanitizeText(
      req.body?.usuario,
      60
    );

    const pin =
      typeof req.body?.pin === 'string'
        ? req.body.pin.trim()
        : '';

    if (!usuario || !pin) {
      return res.status(400).json({
        ok: false,
        message: 'Usuario y PIN son obligatorios'
      });
    }

    const key = attemptKey(req, usuario);
    const state = getAttemptState(key);

    if (
      state.lockedUntil &&
      state.lockedUntil > Date.now()
    ) {
      return res.status(429).json({
        ok: false,
        message:
          'Demasiados intentos. Intenta nuevamente en 15 minutos.'
      });
    }

    const row = await queryOne(
      `
        SELECT
          id,
          usuario,
          nombre,
          pin_hash,
          activo
        FROM meseros_usuarios
        WHERE LOWER(usuario) = LOWER(?)
        LIMIT 1
      `,
      [usuario]
    );

    const active =
      row &&
      (
        row.activo === true ||
        row.activo === 1 ||
        row.activo === '1'
      );

    const valid =
      active &&
      await bcrypt.compare(
        pin,
        row.pin_hash
      );

    if (!valid) {
      recordFailedAttempt(key);

      return res.status(401).json({
        ok: false,
        message: 'Usuario o PIN incorrectos'
      });
    }

    clearAttempts(key);

    const previousAdmin =
      req.session?.user || null;

    req.session.regenerate(error => {
      if (error) {
        console.error(
          'No se pudo regenerar la sesión del personal:',
          error
        );

        return res.status(500).json({
          ok: false,
          message: 'No se pudo iniciar sesión'
        });
      }

      if (previousAdmin) {
        req.session.user =
          previousAdmin;
      }

      req.session.mesero = {
        id: Number(row.id),
        usuario:
          String(row.usuario),
        nombre:
          String(row.nombre)
      };

      return req.session.save(saveError => {
        if (saveError) {
          console.error(
            'No se pudo guardar la sesión del personal:',
            saveError
          );

          return res.status(500).json({
            ok: false,
            message: 'No se pudo iniciar sesión'
          });
        }

        return res.json({
          ok: true,
          mesero:
            req.session.mesero
        });
      });
    });
  } catch (error) {
    console.error(
      'Error iniciando sesión del personal:',
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        'No se pudo iniciar sesión'
    });
  }
});

router.get('/session', async (req, res) => {
  try {
    await waitForTables();

    const sessionWaiter =
      req.session?.mesero;

    if (!sessionWaiter?.id) {
      return res.json({
        ok: true,
        authenticated: false,
        mesero: null
      });
    }

    const row = await queryOne(
      `
        SELECT
          id,
          usuario,
          nombre,
          activo
        FROM meseros_usuarios
        WHERE id = ?
        LIMIT 1
      `,
      [sessionWaiter.id]
    );

    const active =
      row &&
      (
        row.activo === true ||
        row.activo === 1 ||
        row.activo === '1'
      );

    if (!active) {
      delete req.session.mesero;

      return req.session.save(() =>
        res.json({
          ok: true,
          authenticated: false,
          mesero: null
        })
      );
    }

    req.session.mesero = {
      id: Number(row.id),
      usuario:
        String(row.usuario),
      nombre:
        String(row.nombre)
    };

    return res.json({
      ok: true,
      authenticated: true,
      mesero:
        req.session.mesero
    });
  } catch (error) {
    console.error(
      'Error consultando sesión del personal:',
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        'No se pudo consultar la sesión'
    });
  }
});

router.post('/logout', (req, res) => {
  if (!req.session) {
    return res.json({
      ok: true
    });
  }

  delete req.session.mesero;

  return req.session.save(() =>
    res.json({
      ok: true
    })
  );
});

function normalizeIncomingItems(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(0, 80)
    .map(item => {
      const qty = Math.min(
        99,
        Math.max(
          1,
          Math.floor(
            Number(item?.qty || 1)
          )
        )
      );

      const kind =
        item?.kind === 'promotion'
          ? 'promotion'
          : 'product';

      return {
        kind,
        productId:
          sanitizeText(
            item?.productId,
            90
          ),

        optionId:
          sanitizeText(
            item?.optionId,
            90
          ),

        choice:
          sanitizeText(
            item?.choice,
            80
          ),

        notes:
          sanitizeText(
            item?.notes,
            160
          ),

        qty
      };
    })
    .filter(
      item =>
        item.productId &&
        item.optionId
    );
}

function buildStoredChoice(choice, notes) {
  const parts = [];

  if (choice) {
    parts.push(choice);
  }

  if (notes) {
    parts.push(`Nota: ${notes}`);
  }

  return parts.join(' · ').slice(0, 200);
}

async function resolveOrderItems(incoming) {
  const [
    productsValue,
    promotionsValue
  ] = await Promise.all([
    readConfigJson(PRODUCTS_KEY),
    readConfigJson(PROMOS_KEY)
  ]);

  const products =
    Array.isArray(productsValue)
      ? productsValue
      : [];

  const promotions =
    Array.isArray(promotionsValue)
      ? promotionsValue
      : [];

  const resolved = [];

  for (const item of incoming) {
    if (item.kind === 'promotion') {
      const promoId =
        item.productId.startsWith('promo::')
          ? item.productId.slice(7)
          : item.productId;

      const promotion =
        promotions.find(
          promo =>
            String(promo?.id) ===
            String(promoId) &&
            promo?.active !== false
        );

      const price =
        promotion &&
        Array.isArray(promotion.prices)
          ? promotion.prices.find(
              entry =>
                String(entry?.id) ===
                String(item.optionId)
            )
          : null;

      if (
        !promotion ||
        !price ||
        !Number.isFinite(
          Number(price.price)
        )
      ) {
        throw new Error(
          'Una promoción ya no está disponible'
        );
      }

      resolved.push({
        qty: item.qty,

        name:
          `Promoción: ${sanitizeText(
            promotion.title,
            120
          )} - ${sanitizeText(
            price.label || price.name,
            100
          )}`,

        price:
          roundMoney(price.price),

        productId:
          `promo::${sanitizeText(
            promotion.id,
            80
          )}`,

        optionId:
          sanitizeText(
            price.id,
            80
          ),

        choice:
          buildStoredChoice(
            '',
            item.notes
          )
      });

      continue;
    }

    const product =
      products.find(
        entry =>
          String(entry?.id) ===
          String(item.productId) &&
          entry?.active !== false &&
          entry?.available !== false
      );

    const option =
      product &&
      Array.isArray(product.options)
        ? product.options.find(
            entry =>
              String(entry?.id) ===
              String(item.optionId)
          )
        : null;

    if (
      !product ||
      !option ||
      !Number.isFinite(
        Number(option.price)
      )
    ) {
      throw new Error(
        'Un producto ya no está disponible'
      );
    }

    const allowedChoices =
      Array.isArray(product.choices)
        ? product.choices.map(
            value => String(value)
          )
        : [];

    const selectedChoice =
      allowedChoices.includes(
        item.choice
      )
        ? item.choice
        : '';

    resolved.push({
      qty:
        item.qty,

      name:
        `${sanitizeText(
          product.name,
          120
        )} - ${sanitizeText(
          option.name,
          100
        )}`,

      price:
        roundMoney(
          option.price
        ),

      productId:
        sanitizeText(
          product.id,
          80
        ),

      optionId:
        sanitizeText(
          option.id,
          80
        ),

      choice:
        buildStoredChoice(
          selectedChoice,
          item.notes
        )
    });
  }

  return resolved;
}

async function insertInternalOrder(payload) {
  if (usePostgres) {
    const result = await pgPool.query(
      `
        INSERT INTO pedidos (
          cliente_token,
          cliente,
          telefono,
          direccion,
          tipo_entrega,
          productos,
          subtotal,
          envio,
          total,
          estado,
          fecha
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6::jsonb,
          $7,
          $8,
          $9,
          $10,
          $11::timestamptz
        )
        RETURNING *
      `,
      [
        payload.clienteToken,
        payload.cliente,
        '',
        '',
        payload.tipoEntrega,
        JSON.stringify(
          payload.productos
        ),
        payload.subtotal,
        0,
        payload.total,
        'Confirmado',
        payload.fecha
      ]
    );

    return result.rows[0];
  }

  const result = db.prepare(
    `
      INSERT INTO pedidos (
        cliente_token,
        cliente,
        telefono,
        direccion,
        tipo_entrega,
        productos,
        subtotal,
        envio,
        total,
        estado,
        fecha
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    payload.clienteToken,
    payload.cliente,
    '',
    '',
    payload.tipoEntrega,
    JSON.stringify(
      payload.productos
    ),
    payload.subtotal,
    0,
    payload.total,
    'Confirmado',
    payload.fecha
  );

  return db.prepare(
    'SELECT * FROM pedidos WHERE id = ?'
  ).get(
    result.lastInsertRowid
  );
}

function mapOrder(row) {
  let productos = [];

  try {
    productos =
      Array.isArray(row.productos)
        ? row.productos
        : JSON.parse(
            row.productos || '[]'
          );
  } catch {
    productos = [];
  }

  return {
    id:
      Number(row.id),

    cliente:
      String(row.cliente || ''),

    tipoEntrega:
      String(
        row.tipo_entrega ||
        row.tipoEntrega ||
        ''
      ),

    productos,

    subtotal:
      Number(row.subtotal || 0),

    envio:
      Number(row.envio || 0),

    total:
      Number(row.total || 0),

    estado:
      String(row.estado || 'Confirmado'),

    fecha:
      row.fecha
        ? new Date(row.fecha).toISOString()
        : new Date().toISOString()
  };
}

router.post(
  '/orders',
  requireWaiter,
  async (req, res) => {
    try {
      await waitForTables();

      const tipoEntrega =
        sanitizeText(
          req.body?.tipoEntrega,
          40
        );

      if (
        ![
          'Comer aquí',
          'Para llevar'
        ].includes(tipoEntrega)
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Selecciona Comer aquí o Para llevar'
        });
      }

      const incoming =
        normalizeIncomingItems(
          req.body?.items
        );

      if (!incoming.length) {
        return res.status(400).json({
          ok: false,
          message:
            'Agrega al menos un producto'
        });
      }

      let productos;

      try {
        productos =
          await resolveOrderItems(
            incoming
          );
      } catch (error) {
        return res.status(409).json({
          ok: false,
          message:
            error.message ||
            'El catálogo cambió. Actualiza la orden.'
        });
      }

      const subtotal =
        roundMoney(
          productos.reduce(
            (sum, item) =>
              sum +
              Number(item.price || 0) *
              Number(item.qty || 0),
            0
          )
        );

      const row =
        await insertInternalOrder({
          clienteToken:
            `meseros-${randomUUID()}`,

          cliente:
            'Orden interna',

          tipoEntrega,
          productos,
          subtotal,
          total:
            subtotal,

          fecha:
            new Date().toISOString()
        });

      const order =
        mapOrder(row);

      broadcastAdminEvent(
        'orders-updated',
        {
          ts: Date.now(),
          reason: 'created',
          order: {
            id:
              order.id,

            cliente:
              order.cliente,

            tipoEntrega:
              order.tipoEntrega,

            total:
              order.total,

            fecha:
              order.fecha
          }
        }
      );

      return res.status(201).json({
        ok: true,
        pedido:
          order
      });
    } catch (error) {
      console.error(
        'Error guardando orden del personal:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'No se pudo enviar la orden'
      });
    }
  }
);

router.get(
  '/admin/users',
  requireAuth,
  async (req, res) => {
    try {
      await waitForTables();

      const rows = await queryAll(
        `
          SELECT
            id,
            usuario,
            nombre,
            activo,
            creado_en,
            actualizado_en
          FROM meseros_usuarios
          ORDER BY activo DESC, nombre ASC, usuario ASC
        `
      );

      return res.json({
        ok: true,
        users:
          rows.map(publicWaiter)
      });
    } catch (error) {
      console.error(
        'Error listando personal:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'No se pudieron cargar los accesos'
      });
    }
  }
);

router.post(
  '/admin/users',
  requireAuth,
  async (req, res) => {
    try {
      await waitForTables();

      const usuario =
        sanitizeText(
          req.body?.usuario,
          60
        );

      const nombre =
        sanitizeText(
          req.body?.nombre,
          120
        );

      const pin =
        typeof req.body?.pin ===
        'string'
          ? req.body.pin.trim()
          : '';

      if (
        !usuario ||
        !nombre ||
        !isValidPin(pin)
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'Escribe nombre, usuario y un PIN de 4 a 12 números'
        });
      }

      const hash =
        await bcrypt.hash(
          pin,
          10
        );

      if (usePostgres) {
        const result =
          await pgPool.query(
            `
              INSERT INTO meseros_usuarios (
                usuario,
                nombre,
                pin_hash,
                activo
              )
              VALUES ($1, $2, $3, TRUE)
              RETURNING
                id,
                usuario,
                nombre,
                activo
            `,
            [
              usuario,
              nombre,
              hash
            ]
          );

        return res.status(201).json({
          ok: true,
          user:
            publicWaiter(
              result.rows[0]
            )
        });
      }

      const result =
        db.prepare(
          `
            INSERT INTO meseros_usuarios (
              usuario,
              nombre,
              pin_hash,
              activo
            )
            VALUES (?, ?, ?, 1)
          `
        ).run(
          usuario,
          nombre,
          hash
        );

      const row =
        db.prepare(
          `
            SELECT
              id,
              usuario,
              nombre,
              activo
            FROM meseros_usuarios
            WHERE id = ?
          `
        ).get(
          result.lastInsertRowid
        );

      return res.status(201).json({
        ok: true,
        user:
          publicWaiter(row)
      });
    } catch (error) {
      const duplicate =
        String(error?.code || '') ===
          '23505' ||
        /unique/i.test(
          String(error?.message || '')
        );

      if (duplicate) {
        return res.status(409).json({
          ok: false,
          message:
            'Ese usuario ya existe'
        });
      }

      console.error(
        'Error creando acceso de personal:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'No se pudo crear el acceso'
      });
    }
  }
);

router.put(
  '/admin/users/:id',
  requireAuth,
  async (req, res) => {
    try {
      await waitForTables();

      const id =
        Number(req.params.id);

      if (
        !Number.isInteger(id) ||
        id <= 0
      ) {
        return res.status(400).json({
          ok: false,
          message: 'ID inválido'
        });
      }

      const current =
        await queryOne(
          `
            SELECT *
            FROM meseros_usuarios
            WHERE id = ?
            LIMIT 1
          `,
          [id]
        );

      if (!current) {
        return res.status(404).json({
          ok: false,
          message:
            'Acceso no encontrado'
        });
      }

      const usuario =
        sanitizeText(
          req.body?.usuario ??
          current.usuario,
          60
        );

      const nombre =
        sanitizeText(
          req.body?.nombre ??
          current.nombre,
          120
        );

      const activo =
        req.body?.activo === undefined
          ? (
              current.activo === true ||
              current.activo === 1 ||
              current.activo === '1'
            )
          : Boolean(req.body.activo);

      const pin =
        typeof req.body?.pin ===
        'string'
          ? req.body.pin.trim()
          : '';

      if (!usuario || !nombre) {
        return res.status(400).json({
          ok: false,
          message:
            'Nombre y usuario son obligatorios'
        });
      }

      if (
        pin &&
        !isValidPin(pin)
      ) {
        return res.status(400).json({
          ok: false,
          message:
            'El PIN debe tener de 4 a 12 números'
        });
      }

      const hash =
        pin
          ? await bcrypt.hash(
              pin,
              10
            )
          : current.pin_hash;

      await execute(
        `
          UPDATE meseros_usuarios
          SET
            usuario = ?,
            nombre = ?,
            pin_hash = ?,
            activo = ?,
            actualizado_en = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        [
          usuario,
          nombre,
          hash,
          usePostgres
            ? activo
            : (
                activo
                  ? 1
                  : 0
              ),
          id
        ]
      );

      const updated =
        await queryOne(
          `
            SELECT
              id,
              usuario,
              nombre,
              activo
            FROM meseros_usuarios
            WHERE id = ?
            LIMIT 1
          `,
          [id]
        );

      return res.json({
        ok: true,
        user:
          publicWaiter(updated)
      });
    } catch (error) {
      const duplicate =
        String(error?.code || '') ===
          '23505' ||
        /unique/i.test(
          String(error?.message || '')
        );

      if (duplicate) {
        return res.status(409).json({
          ok: false,
          message:
            'Ese usuario ya existe'
        });
      }

      console.error(
        'Error actualizando acceso de personal:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'No se pudo actualizar el acceso'
      });
    }
  }
);

router.delete(
  '/admin/users/:id',
  requireAuth,
  async (req, res) => {
    try {
      await waitForTables();

      const id =
        Number(req.params.id);

      if (
        !Number.isInteger(id) ||
        id <= 0
      ) {
        return res.status(400).json({
          ok: false,
          message: 'ID inválido'
        });
      }

      const result =
        await execute(
          `
            DELETE FROM meseros_usuarios
            WHERE id = ?
          `,
          [id]
        );

      const changes =
        usePostgres
          ? Number(
              result.rowCount || 0
            )
          : Number(
              result.changes || 0
            );

      if (!changes) {
        return res.status(404).json({
          ok: false,
          message:
            'Acceso no encontrado'
        });
      }

      return res.json({
        ok: true,
        deletedId:
          id
      });
    } catch (error) {
      console.error(
        'Error eliminando acceso de personal:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'No se pudo eliminar el acceso'
      });
    }
  }
);

module.exports = router;
