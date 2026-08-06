// KITCHEN_DETAILED_ORDER_CHANGES_V1
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const pgPool = require('../postgres');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { broadcastAdminEvent } = require('../realtime/events');

const router = express.Router();
const usePostgres = Boolean(pgPool);
const PREPARATION_STATES = [
  'Pendiente',
  'Preparando',
  'Listo'
];

function sanitizeText(value, maxLength = 160) {
  if (typeof value !== 'string') return '';

  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizePlaceholders(sql) {
  if (!usePostgres) return String(sql);

  let index = 0;

  return String(sql).replace(
    /\?/g,
    () => `$${++index}`
  );
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

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];

  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeDate(value) {
  const date = new Date(value || Date.now());

  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

function isActive(value) {
  return (
    value === true ||
    value === 1 ||
    value === '1'
  );
}

function publicKitchenUser(row) {
  return {
    id: Number(row.id),
    usuario: String(row.usuario || ''),
    nombre: String(row.nombre || ''),
    activo: isActive(row.activo)
  };
}

function parseObject(value) {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    return value;
  }

  if (!value) return {};

  try {
    const parsed = JSON.parse(String(value));

    return (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    )
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function normalizeKitchenInstruction(item) {
  return sanitizeText(
    item?.choice ||
    item?.opcion ||
    item?.observaciones ||
    item?.notes ||
    item?.note ||
    '',
    240
  );
}

function normalizeKitchenProduct(item) {
  const qty = Math.max(
    0,
    Number(
      item?.qty ??
      item?.cantidad ??
      0
    ) || 0
  );

  const name = sanitizeText(
    item?.name ||
    item?.nombre ||
    'Producto',
    180
  );

  const productId = sanitizeText(
    item?.productId || '',
    100
  );

  const optionId = sanitizeText(
    item?.optionId || '',
    100
  );

  return {
    qty,
    name,
    productId,
    optionId,
    instruction:
      normalizeKitchenInstruction(item)
  };
}

function productComparisonKey(item) {
  if (item.productId || item.optionId) {
    return [
      'catalog',
      item.productId,
      item.optionId
    ].join('::');
  }

  return [
    'name',
    String(item.name || '')
      .trim()
      .toLowerCase()
  ].join('::');
}

function groupKitchenProducts(value) {
  const groups = new Map();

  for (const raw of parseArray(value)) {
    const item = normalizeKitchenProduct(raw);

    if (!item.name || item.qty <= 0) {
      continue;
    }

    const key = productComparisonKey(item);
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        ...item,
        instructions:
          item.instruction
            ? [item.instruction]
            : []
      });

      continue;
    }

    existing.qty += item.qty;

    if (
      item.instruction &&
      !existing.instructions.includes(
        item.instruction
      )
    ) {
      existing.instructions.push(
        item.instruction
      );
    }
  }

  for (const item of groups.values()) {
    item.instruction =
      item.instructions.join(' / ');
  }

  return groups;
}

function buildKitchenChanges(beforeValue, afterValue) {
  const before = parseObject(beforeValue);
  const after = parseObject(afterValue);
  const changes = [];

  const beforeProducts =
    groupKitchenProducts(before.productos);

  const afterProducts =
    groupKitchenProducts(after.productos);

  const keys = new Set([
    ...beforeProducts.keys(),
    ...afterProducts.keys()
  ]);

  for (const key of keys) {
    const previous = beforeProducts.get(key);
    const current = afterProducts.get(key);

    if (!previous && current) {
      changes.push({
        tipo: 'agregado',
        etiqueta: 'AGREGADO',
        nombre: current.name,
        texto:
          `+${current.qty}x ${current.name}`,
        detalle: 'Preparar este producto',
        antes: '',
        ahora: current.instruction || ''
      });

      continue;
    }

    if (previous && !current) {
      changes.push({
        tipo: 'eliminado',
        etiqueta: 'NO PREPARAR',
        nombre: previous.name,
        texto:
          `−${previous.qty}x ${previous.name}`,
        detalle:
          'Producto retirado del pedido',
        antes: previous.instruction || '',
        ahora: ''
      });

      continue;
    }

    if (!previous || !current) continue;

    const difference =
      Number(current.qty) -
      Number(previous.qty);

    if (difference > 0) {
      changes.push({
        tipo: 'aumentado',
        etiqueta: 'PREPARAR EXTRA',
        nombre: current.name,
        texto:
          `${previous.qty}x → ${current.qty}x ${current.name}`,
        detalle:
          `+${difference} por preparar`,
        antes: '',
        ahora: ''
      });
    }

    if (difference < 0) {
      changes.push({
        tipo: 'reducido',
        etiqueta: 'CANTIDAD REDUCIDA',
        nombre: current.name,
        texto:
          `${previous.qty}x → ${current.qty}x ${current.name}`,
        detalle:
          `−${Math.abs(difference)} no preparar`,
        antes: '',
        ahora: ''
      });
    }

    if (
      String(previous.instruction || '') !==
      String(current.instruction || '')
    ) {
      changes.push({
        tipo: 'indicacion',
        etiqueta: 'NUEVA INDICACIÓN',
        nombre: current.name,
        texto: current.name,
        detalle:
          'Revisar la preparación',
        antes:
          previous.instruction ||
          'Sin indicación',
        ahora:
          current.instruction ||
          'Sin indicación'
      });
    }
  }

  const beforeDelivery = sanitizeText(
    before.tipoEntrega || '',
    50
  );

  const afterDelivery = sanitizeText(
    after.tipoEntrega || '',
    50
  );

  if (
    beforeDelivery &&
    afterDelivery &&
    beforeDelivery !== afterDelivery
  ) {
    changes.push({
      tipo: 'entrega',
      etiqueta: 'TIPO DE ENTREGA',
      nombre: 'Tipo de entrega',
      texto:
        `${beforeDelivery} → ${afterDelivery}`,
      detalle:
        'Actualizar la forma de entregar',
      antes: beforeDelivery,
      ahora: afterDelivery
    });
  }

  if (!changes.length) {
    changes.push({
      tipo: 'actualizacion',
      etiqueta: 'PEDIDO ACTUALIZADO',
      nombre: 'Pedido actualizado',
      texto:
        'Se modificó información del pedido',
      detalle:
        'Revisar el pedido actual',
      antes: '',
      ahora: ''
    });
  }

  return changes;
}

function mapKitchenCorrection(row, acknowledgedId) {
  const id = Number(row.id || 0);

  return {
    id,
    fecha: normalizeDate(row.fecha),
    usuario: String(row.usuario || ''),
    motivo: String(row.motivo || ''),
    camposModificados:
      parseArray(row.campos_modificados),
    pendiente:
      id > Number(acknowledgedId || 0),
    cambios:
      buildKitchenChanges(
        row.antes,
        row.despues
      )
  };
}

function mapOrder(row, corrections = []) {
  const latestCorrectionId =
    Number(row.ultima_correccion_id || 0);

  const acknowledgedCorrectionId =
    Number(
      row.ultima_correccion_atendida_id || 0
    );

  return {
    id: Number(row.id),
    tipoEntrega: String(
      row.tipo_entrega || ''
    ),
    productos: parseArray(row.productos),
    total: Number(row.total || 0),
    estado: String(
      row.estado || 'Confirmado'
    ),
    fecha: normalizeDate(row.fecha),
    preparacion: String(
      row.estado_preparacion || 'Pendiente'
    ),
    preparacionActualizada: row.preparacion_actualizada
      ? normalizeDate(row.preparacion_actualizada)
      : null,
    cambiosPendientes:
      latestCorrectionId > 0 &&
      latestCorrectionId >
        acknowledgedCorrectionId,
    ultimaCorreccionId:
      latestCorrectionId,
    ultimaCorreccion: row.ultima_correccion_fecha
      ? {
          id: latestCorrectionId,
          fecha: normalizeDate(
            row.ultima_correccion_fecha
          ),
          motivo: String(
            row.ultima_correccion_motivo || ''
          ),
          camposModificados:
            parseArray(
              row.ultima_correccion_campos
            )
        }
      : null,
    cambiosDetalle:
      Array.isArray(corrections)
        ? corrections
        : []
  };
}

async function initializeKitchenTables() {
  if (usePostgres) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS cocina_usuarios (
        id BIGSERIAL PRIMARY KEY,
        usuario VARCHAR(60) NOT NULL UNIQUE,
        nombre VARCHAR(120) NOT NULL,
        pin_hash TEXT NOT NULL,
        activo BOOLEAN NOT NULL DEFAULT TRUE,
        creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_cocina_usuarios_activo
        ON cocina_usuarios (activo);

      CREATE TABLE IF NOT EXISTS pedidos_preparacion (
        pedido_id BIGINT PRIMARY KEY,
        estado VARCHAR(20) NOT NULL DEFAULT 'Pendiente',
        actualizado_por BIGINT,
        actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT pedidos_preparacion_estado_chk
          CHECK (
            estado IN (
              'Pendiente',
              'Preparando',
              'Listo'
            )
          )
      );

      CREATE TABLE IF NOT EXISTS pedidos_cocina_estado (
        pedido_id BIGINT PRIMARY KEY,
        ultima_correccion_atendida_id BIGINT NOT NULL DEFAULT 0,
        atendido_por TEXT NOT NULL DEFAULT 'admin',
        fecha TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pgPool.query(`
      CREATE OR REPLACE FUNCTION
        reset_preparacion_al_corregir()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        INSERT INTO pedidos_preparacion (
          pedido_id,
          estado,
          actualizado_por,
          actualizado_en
        )
        VALUES (
          NEW.pedido_id,
          'Pendiente',
          NULL,
          NOW()
        )
        ON CONFLICT (pedido_id)
        DO UPDATE SET
          estado = 'Pendiente',
          actualizado_por = NULL,
          actualizado_en = NOW();

        RETURN NEW;
      END;
      $$;
    `);

    await pgPool.query(`
      DROP TRIGGER IF EXISTS
        trg_reset_preparacion_al_corregir
        ON pedidos_correcciones;

      CREATE TRIGGER
        trg_reset_preparacion_al_corregir
      AFTER INSERT ON pedidos_correcciones
      FOR EACH ROW
      EXECUTE FUNCTION
        reset_preparacion_al_corregir();
    `);

    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS cocina_usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT NOT NULL UNIQUE,
      nombre TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      activo INTEGER NOT NULL DEFAULT 1,
      creado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actualizado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_cocina_usuarios_activo
      ON cocina_usuarios (activo);

    CREATE TABLE IF NOT EXISTS pedidos_preparacion (
      pedido_id INTEGER PRIMARY KEY,
      estado TEXT NOT NULL DEFAULT 'Pendiente',
      actualizado_por INTEGER,
      actualizado_en TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        estado IN (
          'Pendiente',
          'Preparando',
          'Listo'
        )
      )
    );

    CREATE TABLE IF NOT EXISTS pedidos_cocina_estado (
      pedido_id INTEGER PRIMARY KEY,
      ultima_correccion_atendida_id INTEGER NOT NULL DEFAULT 0,
      atendido_por TEXT NOT NULL DEFAULT 'admin',
      fecha TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    DROP TRIGGER IF EXISTS
      trg_reset_preparacion_al_corregir;

    CREATE TRIGGER
      trg_reset_preparacion_al_corregir
    AFTER INSERT ON pedidos_correcciones
    BEGIN
      INSERT INTO pedidos_preparacion (
        pedido_id,
        estado,
        actualizado_por,
        actualizado_en
      )
      VALUES (
        NEW.pedido_id,
        'Pendiente',
        NULL,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(pedido_id)
      DO UPDATE SET
        estado = 'Pendiente',
        actualizado_por = NULL,
        actualizado_en = CURRENT_TIMESTAMP;
    END;
  `);
}

let tablesError = null;

const tablesReady =
  initializeKitchenTables().catch(error => {
    tablesError = error;

    console.error(
      'No se pudo inicializar el módulo de Cocina:',
      error
    );
  });

async function waitForTables() {
  await tablesReady;

  if (tablesError) {
    throw tablesError;
  }
}

async function requireKitchen(
  req,
  res,
  next
) {
  try {
    await waitForTables();

    const kitchen =
      req.session?.cocina;

    if (!kitchen?.id) {
      return res.status(401).json({
        ok: false,
        message: 'Inicia sesión en Cocina'
      });
    }

    const row = await queryOne(
      `
        SELECT
          id,
          usuario,
          nombre,
          activo
        FROM cocina_usuarios
        WHERE id = ?
        LIMIT 1
      `,
      [kitchen.id]
    );

    if (!row || !isActive(row.activo)) {
      delete req.session.cocina;

      return req.session.save(() =>
        res.status(401).json({
          ok: false,
          message:
            'Este acceso de Cocina fue desactivado'
        })
      );
    }

    req.kitchenUser =
      publicKitchenUser(row);

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
  return [
    req.ip || 'unknown',
    String(user || '').toLowerCase()
  ].join('::');
}

function attemptState(key) {
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

function failedAttempt(key) {
  const now = Date.now();
  const state = attemptState(key);
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

function validPin(pin) {
  return /^\d{4,12}$/.test(
    String(pin || '')
  );
}

router.post(
  '/login',
  async (req, res) => {
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
          message:
            'Usuario y PIN son obligatorios'
        });
      }

      const key =
        attemptKey(req, usuario);

      const state =
        attemptState(key);

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
          FROM cocina_usuarios
          WHERE LOWER(usuario) = LOWER(?)
          LIMIT 1
        `,
        [usuario]
      );

      const valid =
        row &&
        isActive(row.activo) &&
        await bcrypt.compare(
          pin,
          row.pin_hash
        );

      if (!valid) {
        failedAttempt(key);

        return res.status(401).json({
          ok: false,
          message:
            'Usuario o PIN incorrectos'
        });
      }

      attempts.delete(key);

      const previousAdmin =
        req.session?.user || null;

      const previousWaiter =
        req.session?.mesero || null;

      req.session.regenerate(error => {
        if (error) {
          return res.status(500).json({
            ok: false,
            message:
              'No se pudo iniciar sesión'
          });
        }

        if (previousAdmin) {
          req.session.user =
            previousAdmin;
        }

        if (previousWaiter) {
          req.session.mesero =
            previousWaiter;
        }

        req.session.cocina = {
          id: Number(row.id),
          usuario:
            String(row.usuario),
          nombre:
            String(row.nombre)
        };

        return req.session.save(saveError => {
          if (saveError) {
            return res.status(500).json({
              ok: false,
              message:
                'No se pudo iniciar sesión'
            });
          }

          return res.json({
            ok: true,
            cocina:
              req.session.cocina
          });
        });
      });
    } catch (error) {
      console.error(
        'Error iniciando sesión de Cocina:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'No se pudo iniciar sesión'
      });
    }
  }
);

router.get(
  '/session',
  async (req, res) => {
    try {
      await waitForTables();

      const sessionKitchen =
        req.session?.cocina;

      if (!sessionKitchen?.id) {
        return res.json({
          ok: true,
          authenticated: false,
          cocina: null
        });
      }

      const row = await queryOne(
        `
          SELECT
            id,
            usuario,
            nombre,
            activo
          FROM cocina_usuarios
          WHERE id = ?
          LIMIT 1
        `,
        [sessionKitchen.id]
      );

      if (!row || !isActive(row.activo)) {
        delete req.session.cocina;

        return req.session.save(() =>
          res.json({
            ok: true,
            authenticated: false,
            cocina: null
          })
        );
      }

      req.session.cocina =
        publicKitchenUser(row);

      return res.json({
        ok: true,
        authenticated: true,
        cocina:
          req.session.cocina
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        message:
          'No se pudo consultar la sesión'
      });
    }
  }
);

router.post(
  '/logout',
  (req, res) => {
    if (!req.session) {
      return res.json({
        ok: true
      });
    }

    delete req.session.cocina;

    return req.session.save(() =>
      res.json({
        ok: true
      })
    );
  }
);

async function activeOrders() {
  const correctionFields = usePostgres
    ? 'pc.campos_modificados'
    : 'pc.campos_modificados';

  return queryAll(
    `
      SELECT
        p.id,
        p.tipo_entrega,
        p.productos,
        p.total,
        p.estado,
        p.fecha,
        COALESCE(
          pp.estado,
          'Pendiente'
        ) AS estado_preparacion,
        pp.actualizado_en
          AS preparacion_actualizada,
        pc.id
          AS ultima_correccion_id,
        pc.fecha
          AS ultima_correccion_fecha,
        pc.motivo
          AS ultima_correccion_motivo,
        ${correctionFields}
          AS ultima_correccion_campos,
        pce.ultima_correccion_atendida_id
      FROM pedidos p
      LEFT JOIN pedidos_preparacion pp
        ON pp.pedido_id = p.id
      LEFT JOIN pedidos_cocina_estado pce
        ON pce.pedido_id = p.id
      LEFT JOIN pedidos_correcciones pc
        ON pc.id = (
          SELECT MAX(pc2.id)
          FROM pedidos_correcciones pc2
          WHERE pc2.pedido_id = p.id
        )
      WHERE p.estado = 'Confirmado'
      ORDER BY
        CASE COALESCE(
          pp.estado,
          'Pendiente'
        )
          WHEN 'Preparando' THEN 0
          WHEN 'Pendiente' THEN 1
          WHEN 'Listo' THEN 2
          ELSE 3
        END,
        p.fecha ASC,
        p.id ASC
    `
  );
}

async function correctionDetailsForOrder(row) {
  const acknowledgedId =
    Number(
      row.ultima_correccion_atendida_id || 0
    );

  const corrections = await queryAll(
    `
      SELECT
        id,
        fecha,
        usuario,
        motivo,
        campos_modificados,
        antes,
        despues
      FROM pedidos_correcciones
      WHERE pedido_id = ?
      ORDER BY id DESC
      LIMIT 6
    `,
    [row.id]
  );

  return corrections
    .map(item =>
      mapKitchenCorrection(
        item,
        acknowledgedId
      )
    )
    .reverse();
}

router.get(
  '/orders',
  requireKitchen,
  async (req, res) => {
    try {
      const rows =
        await activeOrders();

      const pedidos = await Promise.all(
        rows.map(async row => {
          const corrections =
            await correctionDetailsForOrder(row);

          return mapOrder(
            row,
            corrections
          );
        })
      );

      return res.json({
        ok: true,
        pedidos,
        estadosPreparacion:
          PREPARATION_STATES
      });
    } catch (error) {
      console.error(
        'Error cargando pedidos de Cocina:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'No se pudieron cargar los pedidos'
      });
    }
  }
);

router.put(
  '/orders/:id/preparation',
  requireKitchen,
  async (req, res) => {
    const id =
      Number(req.params.id);

    const estado =
      sanitizeText(
        req.body?.estado,
        20
      );

    if (
      !Number.isInteger(id) ||
      id <= 0
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Pedido inválido'
      });
    }

    if (
      !PREPARATION_STATES.includes(
        estado
      )
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Estado de preparación inválido'
      });
    }

    try {
      const order = await queryOne(
        `
          SELECT id, estado
          FROM pedidos
          WHERE id = ?
          LIMIT 1
        `,
        [id]
      );

      if (!order) {
        return res.status(404).json({
          ok: false,
          message:
            'Pedido no encontrado'
        });
      }

      if (
        String(order.estado) !==
        'Confirmado'
      ) {
        return res.status(409).json({
          ok: false,
          message:
            'Este pedido ya no está activo en Cocina'
        });
      }

      if (usePostgres) {
        await pgPool.query(
          `
            INSERT INTO pedidos_preparacion (
              pedido_id,
              estado,
              actualizado_por,
              actualizado_en
            )
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (pedido_id)
            DO UPDATE SET
              estado = EXCLUDED.estado,
              actualizado_por =
                EXCLUDED.actualizado_por,
              actualizado_en = NOW()
          `,
          [
            id,
            estado,
            req.kitchenUser.id
          ]
        );
      } else {
        await execute(
          `
            INSERT INTO pedidos_preparacion (
              pedido_id,
              estado,
              actualizado_por,
              actualizado_en
            )
            VALUES (
              ?,
              ?,
              ?,
              CURRENT_TIMESTAMP
            )
            ON CONFLICT(pedido_id)
            DO UPDATE SET
              estado = excluded.estado,
              actualizado_por =
                excluded.actualizado_por,
              actualizado_en =
                CURRENT_TIMESTAMP
          `,
          [
            id,
            estado,
            req.kitchenUser.id
          ]
        );
      }

      broadcastAdminEvent(
        'orders-updated',
        {
          ts: Date.now(),
          reason:
            'kitchen-preparation',
          orderId: id,
          preparation: estado
        }
      );

      return res.json({
        ok: true,
        message:
          `Pedido marcado como ${estado}`,
        pedidoId: id,
        preparacion: estado
      });
    } catch (error) {
      console.error(
        'Error actualizando preparación:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'No se pudo actualizar la preparación'
      });
    }
  }
);

router.post(
  '/orders/:id/acknowledge-changes',
  requireKitchen,
  async (req, res) => {
    const id =
      Number(req.params.id);

    if (
      !Number.isInteger(id) ||
      id <= 0
    ) {
      return res.status(400).json({
        ok: false,
        message: 'Pedido inválido'
      });
    }

    try {
      const latest = await queryOne(
        `
          SELECT MAX(id) AS id
          FROM pedidos_correcciones
          WHERE pedido_id = ?
        `,
        [id]
      );

      const correctionId =
        Number(latest?.id || 0);

      if (!correctionId) {
        return res.status(400).json({
          ok: false,
          message:
            'Este pedido no tiene cambios pendientes'
        });
      }

      if (usePostgres) {
        await pgPool.query(
          `
            INSERT INTO pedidos_cocina_estado (
              pedido_id,
              ultima_correccion_atendida_id,
              atendido_por,
              fecha
            )
            VALUES ($1, $2, 'Cocina', NOW())
            ON CONFLICT (pedido_id)
            DO UPDATE SET
              ultima_correccion_atendida_id =
                EXCLUDED.ultima_correccion_atendida_id,
              atendido_por = 'Cocina',
              fecha = NOW()
          `,
          [id, correctionId]
        );
      } else {
        await execute(
          `
            INSERT INTO pedidos_cocina_estado (
              pedido_id,
              ultima_correccion_atendida_id,
              atendido_por,
              fecha
            )
            VALUES (
              ?,
              ?,
              'Cocina',
              CURRENT_TIMESTAMP
            )
            ON CONFLICT(pedido_id)
            DO UPDATE SET
              ultima_correccion_atendida_id =
                excluded.ultima_correccion_atendida_id,
              atendido_por = 'Cocina',
              fecha = CURRENT_TIMESTAMP
          `,
          [id, correctionId]
        );
      }

      broadcastAdminEvent(
        'orders-updated',
        {
          ts: Date.now(),
          reason:
            'kitchen-changes-acknowledged',
          orderId: id
        }
      );

      return res.json({
        ok: true,
        message:
          'Cambios revisados por Cocina'
      });
    } catch (error) {
      console.error(
        'Error confirmando cambios en Cocina:',
        error
      );

      return res.status(500).json({
        ok: false,
        message:
          'No se pudieron confirmar los cambios'
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

      const rows = await queryAll(`
        SELECT
          id,
          usuario,
          nombre,
          activo,
          creado_en,
          actualizado_en
        FROM cocina_usuarios
        ORDER BY nombre, usuario
      `);

      return res.json({
        ok: true,
        usuarios:
          rows.map(publicKitchenUser)
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        message:
          'No se pudieron cargar los accesos de Cocina'
      });
    }
  }
);

router.post(
  '/admin/users',
  requireAuth,
  async (req, res) => {
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
      typeof req.body?.pin === 'string'
        ? req.body.pin.trim()
        : '';

    if (
      !usuario ||
      !nombre ||
      !validPin(pin)
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Nombre, usuario y PIN de 4 a 12 números son obligatorios'
      });
    }

    try {
      await waitForTables();

      const pinHash =
        await bcrypt.hash(pin, 12);

      if (usePostgres) {
        const result =
          await pgPool.query(
            `
              INSERT INTO cocina_usuarios (
                usuario,
                nombre,
                pin_hash,
                activo,
                actualizado_en
              )
              VALUES ($1, $2, $3, TRUE, NOW())
              RETURNING
                id,
                usuario,
                nombre,
                activo
            `,
            [
              usuario,
              nombre,
              pinHash
            ]
          );

        return res.status(201).json({
          ok: true,
          usuario:
            publicKitchenUser(
              result.rows[0]
            )
        });
      }

      const result = await execute(
        `
          INSERT INTO cocina_usuarios (
            usuario,
            nombre,
            pin_hash,
            activo,
            actualizado_en
          )
          VALUES (
            ?,
            ?,
            ?,
            1,
            CURRENT_TIMESTAMP
          )
        `,
        [
          usuario,
          nombre,
          pinHash
        ]
      );

      const row = await queryOne(
        `
          SELECT
            id,
            usuario,
            nombre,
            activo
          FROM cocina_usuarios
          WHERE id = ?
        `,
        [result.lastInsertRowid]
      );

      return res.status(201).json({
        ok: true,
        usuario:
          publicKitchenUser(row)
      });
    } catch (error) {
      if (
        String(error.message || '')
          .toLowerCase()
          .includes('unique')
      ) {
        return res.status(409).json({
          ok: false,
          message:
            'Ese usuario ya existe'
        });
      }

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
    const id =
      Number(req.params.id);

    if (
      !Number.isInteger(id) ||
      id <= 0
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Usuario inválido'
      });
    }

    try {
      await waitForTables();

      const current = await queryOne(
        `
          SELECT *
          FROM cocina_usuarios
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
        req.body?.activo == null
          ? isActive(current.activo)
          : Boolean(req.body.activo);

      const pin =
        typeof req.body?.pin === 'string'
          ? req.body.pin.trim()
          : '';

      if (!usuario || !nombre) {
        return res.status(400).json({
          ok: false,
          message:
            'Nombre y usuario son obligatorios'
        });
      }

      if (pin && !validPin(pin)) {
        return res.status(400).json({
          ok: false,
          message:
            'El PIN debe tener de 4 a 12 números'
        });
      }

      const pinHash =
        pin
          ? await bcrypt.hash(pin, 12)
          : current.pin_hash;

      await execute(
        `
          UPDATE cocina_usuarios
          SET
            usuario = ?,
            nombre = ?,
            pin_hash = ?,
            activo = ?,
            actualizado_en =
              CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        [
          usuario,
          nombre,
          pinHash,
          usePostgres
            ? activo
            : activo
              ? 1
              : 0,
          id
        ]
      );

      const updated = await queryOne(
        `
          SELECT
            id,
            usuario,
            nombre,
            activo
          FROM cocina_usuarios
          WHERE id = ?
        `,
        [id]
      );

      return res.json({
        ok: true,
        usuario:
          publicKitchenUser(updated)
      });
    } catch (error) {
      if (
        String(error.message || '')
          .toLowerCase()
          .includes('unique')
      ) {
        return res.status(409).json({
          ok: false,
          message:
            'Ese usuario ya existe'
        });
      }

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
    const id =
      Number(req.params.id);

    if (
      !Number.isInteger(id) ||
      id <= 0
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Usuario inválido'
      });
    }

    try {
      await waitForTables();

      await execute(
        `
          DELETE FROM cocina_usuarios
          WHERE id = ?
        `,
        [id]
      );

      return res.json({
        ok: true
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        message:
          'No se pudo eliminar el acceso'
      });
    }
  }
);

router.get(
  '/admin/preparation',
  requireAuth,
  async (req, res) => {
    const ids = String(
      req.query?.ids || ''
    )
      .split(',')
      .map(value => Number(value))
      .filter(
        value =>
          Number.isInteger(value) &&
          value > 0
      )
      .slice(0, 200);

    if (!ids.length) {
      return res.json({
        ok: true,
        estados: []
      });
    }

    try {
      await waitForTables();

      const placeholders =
        ids.map(() => '?').join(',');

      const rows = await queryAll(
        `
          SELECT
            p.id AS pedido_id,
            p.estado AS estado_pedido,
            COALESCE(
              pp.estado,
              'Pendiente'
            ) AS estado_preparacion,
            pp.actualizado_en
          FROM pedidos p
          LEFT JOIN pedidos_preparacion pp
            ON pp.pedido_id = p.id
          WHERE p.id IN (${placeholders})
        `,
        ids
      );

      return res.json({
        ok: true,
        estados:
          rows.map(row => ({
            pedidoId:
              Number(row.pedido_id),
            estadoPedido:
              String(row.estado_pedido || ''),
            preparacion:
              String(
                row.estado_preparacion ||
                'Pendiente'
              ),
            actualizado:
              row.actualizado_en
                ? normalizeDate(
                    row.actualizado_en
                  )
                : null
          }))
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        message:
          'No se pudieron cargar los estados de Cocina'
      });
    }
  }
);

module.exports = {
  router,
  requireKitchen,
  PREPARATION_STATES
};
