// KITCHEN_PRODUCT_CHANGE_MARKERS_V1
'use strict';

const express = require('express');
const pgPool = require('../postgres');
const { requireAuth } = require('../middleware/auth');
const { broadcastAdminEvent } = require('../realtime/events');

const router = express.Router();

let readyPromise = null;

function sanitizeIds(value) {
  const ids = String(value || '')
    .split(',')
    .map(item => Number(item.trim()))
    .filter(id => Number.isInteger(id) && id > 0);

  return Array.from(new Set(ids)).slice(0, 250);
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  if (!value) return {};

  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function parseProducts(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];

  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cleanText(value, maxLength = 260) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeKeyText(value) {
  return cleanText(value, 300)
    .toLocaleLowerCase('es-MX')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function productKey(item) {
  const productId = cleanText(
    item?.productId ?? item?.productoId ?? item?.product_id,
    120
  );

  const optionId = cleanText(
    item?.optionId ?? item?.opcionId ?? item?.option_id,
    120
  );

  if (productId || optionId) {
    return `id:${productId}|${optionId}`;
  }

  const name = normalizeKeyText(
    item?.name ?? item?.nombre ?? 'producto'
  );

  return `name:${name}`;
}

function itemInstruction(item) {
  return cleanText(
    item?.choice ??
      item?.opcion ??
      item?.observaciones ??
      item?.notes ??
      item?.nota ??
      '',
    300
  );
}

function itemQuantity(item) {
  const value = Number(
    item?.qty ?? item?.cantidad ?? item?.quantity ?? 1
  );

  if (!Number.isFinite(value)) return 1;

  return Math.max(0, Math.round(value * 100) / 100);
}

function aggregateProducts(value) {
  const products = parseProducts(value);
  const map = new Map();

  products.forEach((item, index) => {
    const key = productKey(item);
    const qty = itemQuantity(item);

    if (qty <= 0) return;

    const name = cleanText(
      item?.name ?? item?.nombre ?? 'Producto',
      220
    ) || 'Producto';

    const instruction = itemInstruction(item);
    const existing = map.get(key) || {
      key,
      name,
      qty: 0,
      instructions: new Set(),
      order: index
    };

    existing.qty += qty;
    existing.name = existing.name || name;
    existing.order = Math.min(existing.order, index);

    if (instruction) {
      existing.instructions.add(instruction);
    }

    map.set(key, existing);
  });

  return map;
}

function normalizedEntry(entry) {
  if (!entry) return null;

  return {
    key: entry.key,
    name: entry.name,
    qty: Math.round(Number(entry.qty || 0) * 100) / 100,
    instruction: Array.from(entry.instructions || [])
      .sort((a, b) => a.localeCompare(b, 'es'))
      .join(' | '),
    order: Number(entry.order || 0)
  };
}

function compareProducts(beforeValue, afterValue) {
  const beforeMap = aggregateProducts(beforeValue);
  const afterMap = aggregateProducts(afterValue);
  const keys = Array.from(
    new Set([
      ...beforeMap.keys(),
      ...afterMap.keys()
    ])
  );

  const changes = keys.map(key => {
    const before = normalizedEntry(beforeMap.get(key));
    const after = normalizedEntry(afterMap.get(key));
    const previousQty = Number(before?.qty || 0);
    const currentQty = Number(after?.qty || 0);
    const previousInstruction = before?.instruction || '';
    const currentInstruction = after?.instruction || '';
    const instructionChanged =
      previousInstruction !== currentInstruction;

    let kind = 'unchanged';

    if (previousQty <= 0 && currentQty > 0) {
      kind = 'added';
    } else if (previousQty > 0 && currentQty <= 0) {
      kind = 'removed';
    } else if (currentQty > previousQty) {
      kind = 'increased';
    } else if (currentQty < previousQty) {
      kind = 'reduced';
    } else if (instructionChanged) {
      kind = 'instruction_changed';
    }

    return {
      key,
      kind,
      name: after?.name || before?.name || 'Producto',
      previousName: before?.name || '',
      currentName: after?.name || '',
      previousQty,
      currentQty,
      pendingQty:
        kind === 'added'
          ? currentQty
          : kind === 'increased'
            ? Math.max(0, currentQty - previousQty)
            : 0,
      removedQty:
        kind === 'removed'
          ? previousQty
          : kind === 'reduced'
            ? Math.max(0, previousQty - currentQty)
            : 0,
      previousInstruction,
      currentInstruction,
      instructionChanged,
      order: after?.order ?? before?.order ?? 9999
    };
  });

  changes.sort((a, b) => {
    if (a.kind === 'removed' && b.kind !== 'removed') return 1;
    if (a.kind !== 'removed' && b.kind === 'removed') return -1;
    return a.order - b.order;
  });

  return changes;
}

function currentProducts(value) {
  return Array.from(aggregateProducts(value).values())
    .map(normalizedEntry)
    .sort((a, b) => a.order - b.order)
    .map(item => ({
      key: item.key,
      name: item.name,
      qty: item.qty,
      instruction: item.instruction
    }));
}

function hasKitchenProductChanges(items) {
  return items.some(item => item.kind !== 'unchanged');
}

async function ensureTables() {
  if (!pgPool) return;

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS pedidos_cocina_estado (
      pedido_id BIGINT PRIMARY KEY,
      ultima_correccion_atendida_id BIGINT NOT NULL DEFAULT 0,
      atendido_por TEXT NOT NULL DEFAULT 'admin',
      fecha TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS
      idx_pedidos_cocina_estado_correccion
      ON pedidos_cocina_estado (ultima_correccion_atendida_id);
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

function buildSummary(corrections, kitchenState) {
  if (!corrections.length) return null;

  const ordered = [...corrections].sort(
    (a, b) => Number(a.id) - Number(b.id)
  );

  const latest = ordered[ordered.length - 1];
  const latestId = Number(latest.id);
  const acknowledgedId = Math.max(
    0,
    Number(kitchenState?.ultima_correccion_atendida_id || 0)
  );

  const acknowledgedCorrection = ordered.find(
    item => Number(item.id) === acknowledgedId
  );

  const baseline =
    acknowledgedCorrection?.despues || ordered[0].antes || {};

  const original = ordered[0].antes || {};
  const current = latest.despues || {};
  const items = compareProducts(
    baseline.productos,
    current.productos
  );

  const previousDelivery = cleanText(
    baseline.tipoEntrega || baseline.tipo_entrega || '',
    80
  );

  const currentDelivery = cleanText(
    current.tipoEntrega || current.tipo_entrega || '',
    80
  );

  const deliveryChanged =
    previousDelivery !== currentDelivery;

  const allItems = compareProducts(
    original.productos,
    current.productos
  );

  const originalDelivery = cleanText(
    original.tipoEntrega || original.tipo_entrega || '',
    80
  );

  const pendingRelevant =
    hasKitchenProductChanges(items) || deliveryChanged;

  const kitchenRelevant =
    pendingRelevant ||
    hasKitchenProductChanges(allItems) ||
    originalDelivery !== currentDelivery;

  const pending =
    latestId > acknowledgedId && pendingRelevant;

  return {
    orderId: Number(latest.pedido_id),
    latestCorrectionId: latestId,
    acknowledgedCorrectionId: acknowledgedId,
    acknowledged: acknowledgedId >= latestId && kitchenRelevant,
    pending,
    kitchenRelevant,
    correctionCount: ordered.length,
    latestCorrectionAt: latest.fecha,
    latestReason: cleanText(latest.motivo || '', 300),
    previousDelivery,
    currentDelivery,
    deliveryChanged,
    items,
    currentProducts: currentProducts(current.productos)
  };
}

router.get('/cocina/cambios', requireAuth, async (req, res) => {
  try {
    if (!pgPool) {
      return res.status(503).json({
        ok: false,
        message: 'PostgreSQL no está disponible'
      });
    }

    const ids = sanitizeIds(req.query.ids);

    if (!ids.length) {
      return res.json({
        ok: true,
        changes: {}
      });
    }

    await waitReady();

    const [correctionsResult, kitchenResult] = await Promise.all([
      pgPool.query(
        `
          SELECT
            id,
            pedido_id,
            fecha,
            motivo,
            antes,
            despues
          FROM pedidos_correcciones
          WHERE pedido_id = ANY($1::bigint[])
          ORDER BY pedido_id ASC, id ASC
        `,
        [ids]
      ),
      pgPool.query(
        `
          SELECT
            pedido_id,
            ultima_correccion_atendida_id,
            atendido_por,
            fecha
          FROM pedidos_cocina_estado
          WHERE pedido_id = ANY($1::bigint[])
        `,
        [ids]
      )
    ]);

    const correctionsByOrder = new Map();

    correctionsResult.rows.forEach(row => {
      const orderId = Number(row.pedido_id);
      const list = correctionsByOrder.get(orderId) || [];

      list.push({
        ...row,
        antes: parseObject(row.antes),
        despues: parseObject(row.despues)
      });

      correctionsByOrder.set(orderId, list);
    });

    const kitchenByOrder = new Map(
      kitchenResult.rows.map(row => [
        Number(row.pedido_id),
        row
      ])
    );

    const changes = {};

    ids.forEach(orderId => {
      const summary = buildSummary(
        correctionsByOrder.get(orderId) || [],
        kitchenByOrder.get(orderId)
      );

      if (summary?.kitchenRelevant) {
        changes[String(orderId)] = summary;
      }
    });

    return res.json({
      ok: true,
      changes
    });
  } catch (error) {
    console.error(
      'Error consultando cambios para cocina:',
      error
    );

    return res.status(500).json({
      ok: false,
      message: 'No se pudieron consultar los cambios para cocina'
    });
  }
});

router.post(
  '/cocina/pedidos/:id/atender',
  requireAuth,
  async (req, res) => {
    try {
      if (!pgPool) {
        return res.status(503).json({
          ok: false,
          message: 'PostgreSQL no está disponible'
        });
      }

      const orderId = Number(req.params.id);
      const requestedCorrectionId = Number(
        req.body?.correctionId
      );

      if (
        !Number.isInteger(orderId) ||
        orderId <= 0 ||
        !Number.isInteger(requestedCorrectionId) ||
        requestedCorrectionId <= 0
      ) {
        return res.status(400).json({
          ok: false,
          message: 'Pedido o corrección inválidos'
        });
      }

      await waitReady();

      const latestResult = await pgPool.query(
        `
          SELECT id
          FROM pedidos_correcciones
          WHERE pedido_id = $1
          ORDER BY id DESC
          LIMIT 1
        `,
        [orderId]
      );

      const latestId = Number(latestResult.rows[0]?.id || 0);

      if (!latestId) {
        return res.status(404).json({
          ok: false,
          message: 'Este pedido no tiene cambios registrados'
        });
      }

      if (latestId !== requestedCorrectionId) {
        return res.status(409).json({
          ok: false,
          message:
            'El pedido recibió otro cambio. Actualiza antes de marcarlo.'
        });
      }

      const user = cleanText(
        req.session?.user?.usuario || 'admin',
        100
      ) || 'admin';

      const result = await pgPool.query(
        `
          INSERT INTO pedidos_cocina_estado (
            pedido_id,
            ultima_correccion_atendida_id,
            atendido_por,
            fecha
          )
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (pedido_id)
          DO UPDATE SET
            ultima_correccion_atendida_id = EXCLUDED.ultima_correccion_atendida_id,
            atendido_por = EXCLUDED.atendido_por,
            fecha = NOW()
          RETURNING *
        `,
        [orderId, latestId, user]
      );

      broadcastAdminEvent(
        'orders-updated',
        {
          ts: Date.now(),
          reason: 'kitchen-changes-acknowledged',
          orderId,
          correctionId: latestId
        }
      );

      return res.json({
        ok: true,
        message: 'Cambios marcados como atendidos',
        state: result.rows[0]
      });
    } catch (error) {
      console.error(
        'Error marcando cambios de cocina:',
        error
      );

      return res.status(500).json({
        ok: false,
        message: 'No se pudieron marcar los cambios como atendidos'
      });
    }
  }
);

if (pgPool) {
  void waitReady().catch(error => {
    console.error(
      'No se pudo preparar el estado de cambios de cocina:',
      error
    );
  });
}

module.exports = router;
