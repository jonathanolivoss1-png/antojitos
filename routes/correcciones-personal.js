// PERSONAL_CONTROLLED_CORRECTIONS_V1
'use strict';

const express = require('express');
const crypto = require('crypto');
const pgPool = require('../postgres');
const { broadcastAdminEvent } = require('../realtime/events');

const router = express.Router();
const PRODUCTS_KEY = 'site_products_v1';
const PROMOS_KEY = 'site_promotions_v1';

function sanitizeText(value, maxLength = 200) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function roundMoney(value) {
  const number = Number(value || 0);
  return Math.round((Number.isFinite(number) ? number : 0) * 100) / 100;
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

function normalizeIncomingItems(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 80)
    .map(item => ({
      kind: item?.kind === 'promotion' ? 'promotion' : 'product',
      productId: sanitizeText(item?.productId || '', 90),
      optionId: sanitizeText(item?.optionId || '', 90),
      choice: sanitizeText(item?.choice || '', 80),
      notes: sanitizeText(item?.notes || '', 160),
      qty: Math.min(99, Math.max(1, Math.floor(Number(item?.qty || 1))))
    }))
    .filter(item => item.productId && item.optionId);
}

function buildStoredChoice(choice, notes) {
  const parts = [];
  if (choice) parts.push(choice);
  if (notes) parts.push(`Nota: ${notes}`);
  return parts.join(' · ').slice(0, 240);
}

async function readConfigJson(key) {
  const result = await pgPool.query(
    'SELECT valor FROM configuracion WHERE clave = $1 LIMIT 1',
    [key]
  );
  const row = result.rows[0];
  if (!row || row.valor == null) return null;
  if (typeof row.valor !== 'string') return row.valor;
  try {
    return JSON.parse(row.valor);
  } catch {
    return null;
  }
}

async function resolveOrderItems(incoming) {
  const [productsValue, promotionsValue] = await Promise.all([
    readConfigJson(PRODUCTS_KEY),
    readConfigJson(PROMOS_KEY)
  ]);
  const products = Array.isArray(productsValue) ? productsValue : [];
  const promotions = Array.isArray(promotionsValue) ? promotionsValue : [];
  const resolved = [];

  for (const item of incoming) {
    if (item.kind === 'promotion') {
      const promotionId = item.productId.startsWith('promo::')
        ? item.productId.slice(7)
        : item.productId;
      const promotion = promotions.find(
        entry =>
          String(entry?.id) === String(promotionId) &&
          entry?.active !== false
      );
      const option =
        promotion && Array.isArray(promotion.prices)
          ? promotion.prices.find(
              entry => String(entry?.id) === String(item.optionId)
            )
          : null;

      if (!promotion || !option || !Number.isFinite(Number(option.price))) {
        throw new Error('Una promoción de la orden ya no está disponible');
      }

      resolved.push({
        qty: item.qty,
        name:
          `Promoción: ${sanitizeText(promotion.title, 120)} - ` +
          `${sanitizeText(option.label || option.name, 100)}`,
        price: roundMoney(option.price),
        productId: `promo::${sanitizeText(promotion.id, 80)}`,
        optionId: sanitizeText(option.id, 80),
        choice: buildStoredChoice('', item.notes)
      });
      continue;
    }

    const product = products.find(
      entry =>
        String(entry?.id) === String(item.productId) &&
        entry?.active !== false &&
        entry?.available !== false
    );
    const option =
      product && Array.isArray(product.options)
        ? product.options.find(
            entry => String(entry?.id) === String(item.optionId)
          )
        : null;

    if (!product || !option || !Number.isFinite(Number(option.price))) {
      throw new Error('Un producto de la orden ya no está disponible');
    }

    const allowedChoices = Array.isArray(product.choices)
      ? product.choices.map(String)
      : [];
    const selectedChoice = allowedChoices.includes(item.choice)
      ? item.choice
      : '';

    resolved.push({
      qty: item.qty,
      name:
        `${sanitizeText(product.name, 120)} - ` +
        `${sanitizeText(option.name, 100)}`,
      price: roundMoney(option.price),
      productId: sanitizeText(product.id, 80),
      optionId: sanitizeText(option.id, 80),
      choice: buildStoredChoice(selectedChoice, item.notes)
    });
  }

  return resolved;
}

function comparableOrder(order) {
  return {
    cliente: order.cliente,
    telefono: order.telefono,
    direccion: order.direccion,
    tipoEntrega: order.tipoEntrega,
    productos: order.productos,
    subtotal: roundMoney(order.subtotal),
    envio: roundMoney(order.envio),
    total: roundMoney(order.total),
    estado: order.estado
  };
}

function revisionForOrder(order) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(comparableOrder(order)))
    .digest('hex');
}

function mapOrder(row) {
  const order = {
    id: Number(row.id),
    clienteToken: String(row.cliente_token || ''),
    cliente: String(row.cliente || ''),
    telefono: String(row.telefono || ''),
    direccion: String(row.direccion || ''),
    tipoEntrega: String(row.tipo_entrega || ''),
    productos: parseArray(row.productos),
    subtotal: Number(row.subtotal || 0),
    envio: Number(row.envio || 0),
    total: Number(row.total || 0),
    estado: String(row.estado || 'Confirmado'),
    fecha: normalizeDate(row.fecha)
  };
  return { ...order, revision: revisionForOrder(order) };
}

function changedFields(before, after) {
  return Object.keys(after).filter(
    key => JSON.stringify(before[key]) !== JSON.stringify(after[key])
  );
}

function isInternalOrder(row) {
  return (
    String(row.cliente_token || '').startsWith('meseros-') ||
    String(row.cliente || '') === 'Orden interna'
  );
}

let readyPromise = null;

async function ensureTables() {
  if (!pgPool) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS pedidos_correcciones (
      id BIGSERIAL PRIMARY KEY,
      pedido_id BIGINT NOT NULL,
      fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      usuario_id BIGINT,
      usuario TEXT NOT NULL DEFAULT 'admin',
      motivo TEXT NOT NULL,
      campos_modificados JSONB NOT NULL DEFAULT '[]'::jsonb,
      antes JSONB NOT NULL,
      despues JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pedidos_correcciones_pedido
      ON pedidos_correcciones (pedido_id, fecha DESC);
  `);
}

async function waitReady() {
  if (!pgPool) return;
  if (!readyPromise) {
    readyPromise = ensureTables().catch(error => {
      readyPromise = null;
      throw error;
    });
  }
  await readyPromise;
}

async function requirePersonal(req, res, next) {
  try {
    if (!pgPool) {
      return res.status(503).json({
        ok: false,
        message: 'PostgreSQL no está disponible'
      });
    }

    const sessionPersonal = req.session?.mesero;
    if (!sessionPersonal?.id) {
      return res.status(401).json({
        ok: false,
        message: 'Inicia sesión como personal'
      });
    }

    const result = await pgPool.query(
      `
        SELECT id, usuario, nombre, activo
        FROM meseros_usuarios
        WHERE id = $1
        LIMIT 1
      `,
      [sessionPersonal.id]
    );
    const user = result.rows[0];

    if (!user || user.activo !== true) {
      delete req.session.mesero;
      return res.status(401).json({
        ok: false,
        message: 'El acceso del personal ya no está activo'
      });
    }

    req.personalUser = {
      id: Number(user.id),
      usuario: String(user.usuario || ''),
      nombre: String(user.nombre || '')
    };
    return next();
  } catch (error) {
    console.error('Error validando sesión de Personal:', error);
    return res.status(500).json({
      ok: false,
      message: 'No se pudo validar la sesión'
    });
  }
}

router.get('/orders/correctable', requirePersonal, async (req, res) => {
  try {
    await waitReady();
    const result = await pgPool.query(`
      SELECT *
      FROM pedidos
      WHERE estado = 'Confirmado'
        AND (
          cliente = 'Orden interna'
          OR cliente_token LIKE 'meseros-%'
        )
      ORDER BY fecha DESC, id DESC
      LIMIT 100
    `);

    return res.json({
      ok: true,
      pedidos: result.rows.map(mapOrder)
    });
  } catch (error) {
    console.error('Error cargando pedidos corregibles para Personal:', error);
    return res.status(500).json({
      ok: false,
      message: 'No se pudieron cargar los pedidos'
    });
  }
});

router.put('/orders/:id/correction', requirePersonal, async (req, res) => {
  if (!pgPool) {
    return res.status(503).json({
      ok: false,
      message: 'PostgreSQL no está disponible'
    });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({
      ok: false,
      message: 'Pedido inválido'
    });
  }

  const motivo = sanitizeText(req.body?.motivo || '', 300);
  if (motivo.length < 5) {
    return res.status(400).json({
      ok: false,
      message: 'Escribe un motivo de al menos 5 caracteres'
    });
  }

  const tipoEntrega = sanitizeText(req.body?.tipoEntrega || '', 40);
  if (!['Comer aquí', 'Para llevar'].includes(tipoEntrega)) {
    return res.status(400).json({
      ok: false,
      message: 'Selecciona Comer aquí o Para llevar'
    });
  }

  const revision = sanitizeText(req.body?.revision || '', 128);
  if (!revision) {
    return res.status(400).json({
      ok: false,
      message: 'Vuelve a cargar el pedido antes de corregirlo'
    });
  }

  const incoming = normalizeIncomingItems(req.body?.items);
  if (!incoming.length) {
    return res.status(400).json({
      ok: false,
      message: 'El pedido debe conservar al menos un producto'
    });
  }

  let productos;
  try {
    productos = await resolveOrderItems(incoming);
  } catch (error) {
    return res.status(409).json({
      ok: false,
      message:
        error.message ||
        'El catálogo cambió. Vuelve a cargar la orden.'
    });
  }

  const subtotal = roundMoney(
    productos.reduce(
      (sum, item) =>
        sum + Number(item.price || 0) * Number(item.qty || 0),
      0
    )
  );
  const total = subtotal;

  await waitReady();
  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      'SELECT * FROM pedidos WHERE id = $1 FOR UPDATE',
      [id]
    );
    const currentRow = currentResult.rows[0];

    if (!currentRow || !isInternalOrder(currentRow)) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        ok: false,
        message: 'Pedido interno no encontrado'
      });
    }

    if (String(currentRow.estado) !== 'Confirmado') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        ok: false,
        message: 'Solo se pueden corregir pedidos que sigan Confirmados'
      });
    }

    const currentOrder = mapOrder(currentRow);
    if (currentOrder.revision !== revision) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        ok: false,
        message: 'El pedido cambió en otro dispositivo. Vuelve a cargarlo.'
      });
    }

    const before = comparableOrder(currentOrder);
    const after = {
      ...before,
      tipoEntrega,
      productos,
      subtotal,
      envio: 0,
      total
    };
    const fields = changedFields(before, after);

    if (!fields.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        ok: false,
        message: 'No realizaste cambios en el pedido'
      });
    }

    const updatedResult = await client.query(
      `
        UPDATE pedidos
        SET
          tipo_entrega = $1,
          productos = $2::jsonb,
          subtotal = $3,
          envio = 0,
          total = $4
        WHERE id = $5
        RETURNING *
      `,
      [
        tipoEntrega,
        JSON.stringify(productos),
        subtotal,
        total,
        id
      ]
    );

    const correctionResult = await client.query(
      `
        INSERT INTO pedidos_correcciones (
          pedido_id,
          usuario_id,
          usuario,
          motivo,
          campos_modificados,
          antes,
          despues
        )
        VALUES (
          $1,
          $2,
          'Personal',
          $3,
          $4::jsonb,
          $5::jsonb,
          $6::jsonb
        )
        RETURNING id, fecha
      `,
      [
        id,
        req.personalUser.id,
        motivo,
        JSON.stringify(fields),
        JSON.stringify(before),
        JSON.stringify(after)
      ]
    );

    await client.query('COMMIT');
    const updatedOrder = mapOrder(updatedResult.rows[0]);

    broadcastAdminEvent('orders-updated', {
      ts: Date.now(),
      reason: 'personal-correction',
      orderId: id,
      fields
    });

    return res.json({
      ok: true,
      message: 'Pedido corregido y registrado en el historial',
      pedido: updatedOrder,
      correction: {
        id: Number(correctionResult.rows[0].id),
        fecha: normalizeDate(correctionResult.rows[0].fecha),
        usuario: 'Personal',
        motivo,
        camposModificados: fields
      }
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error corrigiendo pedido desde Personal:', error);
    return res.status(500).json({
      ok: false,
      message: 'No se pudo corregir el pedido'
    });
  } finally {
    client.release();
  }
});

module.exports = router;
