const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const pgPool = require('../postgres');
const usePostgres = Boolean(pgPool);
const { maybeArchiveAndResetDailyOrders } = require('../database/init');
const { requireAuth } = require('../middleware/auth');
const {
  attachAdminEventClient,
  attachPublicSettingsClient,
  broadcastAdminEvent,
  broadcastPublicSettingsEvent
} = require('../realtime/events');

const router = express.Router();
const PROMOS_KEY = 'site_promotions_v1';
const PRODUCTS_KEY = 'site_products_v1';
const CONTENT_KEY = 'site_content_v1';
const CALCULATOR_DRAFT_KEY = 'calculator_draft_v1';
const SOLD_PRODUCTS_SEPARATED_KEY = 'sold_products_separated_v1';
const MEXICO_CITY_TZ_OFFSET_MINUTES = 360;

function parseProductos(raw) {
  try {
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

function sanitizeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function sanitizeText(value, maxLength = 220) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, maxLength);
}

function isValidDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function buildUtcRangeFromDateKey(dateKey, tzOffsetMinutes) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const safeOffset = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0;
  const startUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0) + safeOffset * 60 * 1000;
  const endUtcMs = startUtcMs + 24 * 60 * 60 * 1000;

  return {
    startIso: new Date(startUtcMs).toISOString(),
    endIso: new Date(endUtcMs).toISOString()
  };
}

function buildUtcMonthRangeFromDateKey(dateKey, tzOffsetMinutes) {
  const [year, month] = String(dateKey).split('-').map(Number);
  const safeOffset = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0;
  const startUtcMs = Date.UTC(year, month - 1, 1, 0, 0, 0, 0) + safeOffset * 60 * 1000;
  const endUtcMs = Date.UTC(year, month, 1, 0, 0, 0, 0) + safeOffset * 60 * 1000;

  return {
    startIso: new Date(startUtcMs).toISOString(),
    endIso: new Date(endUtcMs).toISOString()
  };
}

function getMexicoCityDateKey(date = new Date()) {
  const utcMillis = date.getTime();
  const localMillis = utcMillis - MEXICO_CITY_TZ_OFFSET_MINUTES * 60 * 1000;
  const localDate = new Date(localMillis);
  const year = localDate.getUTCFullYear();
  const month = String(localDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(localDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizeSqlPlaceholders(sql) {
  if (!usePostgres) return String(sql);
  let index = 0;
  return String(sql).replace(/\?/g, () => `$${++index}`);
}

async function querySingle(sql, params = []) {
  if (usePostgres) {
    const normalized = normalizeSqlPlaceholders(sql);
    const result = await pgPool.query(normalized, params);
    return result.rows[0];
  }

  return db.prepare(sql).get(...params);
}

async function queryAll(sql, params = []) {
  if (usePostgres) {
    const normalized = normalizeSqlPlaceholders(sql);
    const result = await pgPool.query(normalized, params);
    return result.rows;
  }

  return db.prepare(sql).all(...params);
}

async function execute(sql, params = []) {
  if (usePostgres) {
    const normalized = normalizeSqlPlaceholders(sql);
    return await pgPool.query(normalized, params);
  }

  return db.prepare(sql).run(...params);
}

async function readConfigJson(key) {
  const row = await querySingle('SELECT valor FROM configuracion WHERE clave = ? LIMIT 1', [key]);
  if (!row?.valor) return null;
  if (usePostgres && typeof row.valor !== 'string') return row.valor;
  try {
    return JSON.parse(row.valor);
  } catch {
    return null;
  }
}

async function writeConfigJson(key, value) {
  const payload = JSON.stringify(value);

  if (usePostgres) {
    await execute(`
      INSERT INTO configuracion (clave, valor)
      VALUES (?, ?::jsonb)
      ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor
    `, [key, payload]);
    return;
  }

  await execute(`
    INSERT INTO configuracion (clave, valor)
    VALUES (?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor
  `, [key, payload]);
}

function normalizePromotions(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((promo, index) => {
      const id = sanitizeText(promo?.id || `promo-${index + 1}`, 90);
      const title = sanitizeText(promo?.title || '', 140);
      const text = sanitizeText(promo?.text || '', 420);
      const chip = sanitizeText(promo?.chip || 'Promo', 60);
      const active = Boolean(promo?.active);
      const prices = normalizePromotionPrices(promo?.prices);

      if (!id || !title || !text) return null;
      return {
        id,
        title,
        text,
        chip,
        active,
        ...(prices.length ? { prices } : {})
      };
    })
    .filter(Boolean);
}

function normalizePromotionPrices(prices) {
  if (!Array.isArray(prices)) return [];

  return prices
    .map((item, index) => {
      const id = sanitizeText(item?.id || `promo-price-${index + 1}`, 90);
      const label = sanitizeText(item?.label || item?.name || '', 120);
      const price = Number(item?.price);
      if (!id || !label || !Number.isFinite(price) || price < 0) return null;

      return {
        id,
        label,
        price: Math.round(price * 100) / 100
      };
    })
    .filter(Boolean);
}

function normalizeProductOptions(options) {
  if (!Array.isArray(options)) return [];

  return options
    .map((option, index) => {
      const id = sanitizeText(option?.id || `option-${index + 1}`, 90);
      const name = sanitizeText(option?.name || '', 120);
      const price = Number(option?.price);
      if (!id || !name || !Number.isFinite(price) || price < 0) return null;
      return {
        id,
        name,
        price: Math.round(price * 100) / 100
      };
    })
    .filter(Boolean);
}

function normalizeProductChoices(choices) {
  if (!Array.isArray(choices)) return undefined;
  const clean = choices
    .map(choice => sanitizeText(choice, 80))
    .filter(Boolean);
  return clean.length ? clean : undefined;
}

function normalizeSoldProductName(value) {
  return sanitizeText(value, 140)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSoldProductsSeparated(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Set();
  value.forEach(item => {
    const normalized = normalizeSoldProductName(item);
    if (normalized) unique.add(normalized);
  });
  return Array.from(unique.values()).slice(0, 500);
}

function normalizeContent(value) {
  const source = value && typeof value === 'object' ? value : {};
  const recommendations = Array.isArray(source.recommendations)
    ? source.recommendations.map(item => sanitizeText(item, 120)).filter(Boolean).slice(0, 12)
    : [];

  return {
    heroBadge: sanitizeText(source.heroBadge || '', 140),
    heroTitle: sanitizeText(source.heroTitle || '', 180),
    heroText: sanitizeText(source.heroText || '', 420),
    recommendations
  };
}

function normalizeProducts(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((product, index) => {
      const id = sanitizeText(product?.id || `product-${index + 1}`, 90);
      const name = sanitizeText(product?.name || '', 140);
      const description = sanitizeText(product?.description || '', 380);
      const image = sanitizeText(product?.image || '', 420);
      const category = sanitizeText(product?.category || 'general', 80);
      const tag = sanitizeText(product?.tag || '', 80);
      const note = sanitizeText(product?.note || '', 240);
      const priceLabel = sanitizeText(product?.priceLabel || '', 80);
      const active = Boolean(product?.active);
      const available = Boolean(product?.available);
      const options = normalizeProductOptions(product?.options);
      const choices = normalizeProductChoices(product?.choices);

      if (!id || !name || !description || !options.length) return null;

      return {
        id,
        name,
        description,
        image,
        category,
        tag,
        note,
        priceLabel,
        active,
        available,
        options,
        ...(choices ? { choices } : {})
      };
    })
    .filter(Boolean);
}

async function readPromotions() {
  const parsed = await readConfigJson(PROMOS_KEY);
  return normalizePromotions(parsed || []);
}

async function writePromotions(promotions) {
  await writeConfigJson(PROMOS_KEY, promotions);
}

async function readProducts() {
  const parsed = await readConfigJson(PRODUCTS_KEY);
  return normalizeProducts(parsed || []);
}

async function writeProducts(products) {
  await writeConfigJson(PRODUCTS_KEY, products);
}

async function readContent() {
  const parsed = await readConfigJson(CONTENT_KEY);
  return normalizeContent(parsed || {});
}

async function writeContent(content) {
  await writeConfigJson(CONTENT_KEY, content);
}

async function readSoldProductsSeparated() {
  const parsed = await readConfigJson(SOLD_PRODUCTS_SEPARATED_KEY);
  return normalizeSoldProductsSeparated(parsed || []);
}

async function writeSoldProductsSeparated(names) {
  const clean = normalizeSoldProductsSeparated(names);
  await writeConfigJson(SOLD_PRODUCTS_SEPARATED_KEY, clean);
  return clean;
}

function normalizeCalculatorDraft(value) {
  const source = value && typeof value === 'object' ? value : {};
  const products = Array.isArray(source.products)
    ? source.products
        .map((item, index) => {
          const id = sanitizeText(item?.id || `draft-item-${index + 1}`, 100);
          const name = sanitizeText(item?.name || '', 120);
          const qty = Math.max(0, sanitizeNumber(item?.qty));
          const price = Math.max(0, sanitizeNumber(item?.price));
          if (!id) return null;
          return { id, name, qty, price };
        })
        .filter(Boolean)
    : [];

  return {
    products,
    manualIncomeValue: Math.max(0, sanitizeNumber(source.manualIncomeValue || 0)),
    useDashboardRevenue: Boolean(source.useDashboardRevenue),
    updatedAt: Math.max(0, sanitizeNumber(source.updatedAt || 0))
  };
}

function hasMeaningfulDraftProducts(draft) {
  const products = Array.isArray(draft?.products) ? draft.products : [];
  return products.some(item => {
    const name = String(item?.name || '').trim();
    const price = Number(item?.price || 0);
    return Boolean(name) || (Number.isFinite(price) && price > 0);
  });
}

router.put('/password', requireAuth, async (req, res) => {
  try {
    const nextPassword = sanitizeText(req.body?.password || '', 80);
    if (!nextPassword) {
      return res.status(400).json({ ok: false, message: 'La contraseña no puede quedar vacía' });
    }

    const hash = bcrypt.hashSync(nextPassword, 10);
    const result = await execute('UPDATE usuarios SET password = ? WHERE usuario = ?', [hash, 'admin']);
    const changes = usePostgres ? result.rowCount : result.changes;
    if (!changes) {
      return res.status(404).json({ ok: false, message: 'No se encontró el usuario administrador' });
    }

    return res.json({ ok: true, message: 'Contraseña actualizada' });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo actualizar la contraseña' });
  }
});

function normalizeCalculatorProducts(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map(item => {
      const name = sanitizeText(item?.name || '', 120);
      const qty = sanitizeNumber(item?.qty);
      const costUnit = sanitizeNumber(item?.costUnit);
      const priceUnit = sanitizeNumber(item?.priceUnit);
      const costTotal = qty * costUnit;
      const hasSalePrice = Number.isFinite(priceUnit) && priceUnit >= 0 && String(item?.priceUnit ?? '').trim() !== '';
      const saleTotal = hasSalePrice ? qty * priceUnit : 0;
      const gain = saleTotal - costTotal;
      const margin = saleTotal > 0 ? (gain / saleTotal) * 100 : 0;

      if (!name || qty <= 0) return null;

      return {
        name,
        qty,
        costUnit: Math.round(costUnit * 100) / 100,
        priceUnit: Math.round(priceUnit * 100) / 100,
        costTotal: Math.round(costTotal * 100) / 100,
        saleTotal: Math.round(saleTotal * 100) / 100,
        gananciaEstimada: Math.round(gain * 100) / 100,
        margenGanancia: Math.round(margin * 100) / 100
      };
    })
    .filter(Boolean);
}

function calculateCalculatorTotals(productos) {
  const costoTotal = productos.reduce((sum, item) => sum + Number(item.costTotal || 0), 0);
  const ventaTotal = productos.reduce((sum, item) => sum + Number(item.saleTotal || 0), 0);
  const gananciaEstimada = ventaTotal - costoTotal;
  const margenGanancia = ventaTotal > 0 ? (gananciaEstimada / ventaTotal) * 100 : 0;

  return {
    costoTotal: Math.round(costoTotal * 100) / 100,
    ventaTotal: Math.round(ventaTotal * 100) / 100,
    gananciaEstimada: Math.round(gananciaEstimada * 100) / 100,
    margenGanancia: Math.round(margenGanancia * 100) / 100
  };
}

function normalizeCalculatorPayload(body) {
  const productos = normalizeCalculatorProducts(body?.productos || []);
  const totals = calculateCalculatorTotals(productos);
  const origen = ['manual', 'dashboard', 'sin_cantidad_inicial'].includes(sanitizeText(body?.origen || 'manual', 40))
    ? sanitizeText(body?.origen || 'manual', 40)
    : 'manual';
  const tipoCantidad = ['bruta', 'neta'].includes(sanitizeText(body?.tipoCantidad || 'bruta', 20))
    ? sanitizeText(body?.tipoCantidad || 'bruta', 20)
    : 'bruta';
  const cantidadDisponible = sanitizeNumber(body?.cantidadDisponible || 0);

  let saldoRestante = 0;
  if (origen !== 'sin_cantidad_inicial') {
    saldoRestante = tipoCantidad === 'neta' ? cantidadDisponible : cantidadDisponible - totals.costoTotal;
  }

  return {
    origen,
    cantidadDisponible: Math.round(cantidadDisponible * 100) / 100,
    tipoCantidad,
    cantidadProductos: productos.length,
    costoTotal: totals.costoTotal,
    ventaTotal: totals.ventaTotal,
    gananciaEstimada: totals.gananciaEstimada,
    margenGanancia: totals.margenGanancia,
    saldoRestante: Math.round(saldoRestante * 100) / 100,
    productos
  };
}

function mapCalculatorRow(row) {
  const productos = db.prepare('SELECT * FROM calculadora_productos WHERE calculo_id = ? ORDER BY id').all(row.id);
  return {
    id: row.id,
    fecha: row.fecha,
    origen: row.origen,
    cantidadDisponible: Number(row.cantidad_disponible || 0),
    tipoCantidad: row.tipo_cantidad,
    cantidadProductos: Number(row.cantidad_productos || 0),
    costoTotal: Number(row.costo_total || 0),
    ventaTotal: Number(row.venta_total || 0),
    gananciaEstimada: Number(row.ganancia_estimada || 0),
    margenGanancia: Number(row.margen_ganancia || 0),
    saldoRestante: Number(row.saldo_restante || 0),
    productos: productos.map(item => ({
      id: item.id,
      nombre: item.nombre,
      cantidad: Number(item.cantidad || 0),
      costoUnitario: Number(item.costo_unitario || 0),
      precioVentaUnitario: Number(item.precio_venta_unitario || 0),
      costoTotal: Number(item.costo_total || 0),
      ventaTotal: Number(item.venta_total || 0),
      gananciaEstimada: Number(item.ganancia_estimada || 0),
      margenGanancia: Number(item.margen_ganancia || 0)
    }))
  };
}

router.post('/calculadora', requireAuth, (req, res) => {
  try {
    const payload = normalizeCalculatorPayload(req.body || {});
    const insertCalculation = db.prepare(`
      INSERT INTO calculadora_calculos (
        fecha, origen, cantidad_disponible, tipo_cantidad, cantidad_productos, costo_total, venta_total, ganancia_estimada, margen_ganancia, saldo_restante
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertProduct = db.prepare(`
      INSERT INTO calculadora_productos (
        calculo_id, nombre, cantidad, costo_unitario, precio_venta_unitario, costo_total, venta_total, ganancia_estimada, margen_ganancia
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      const result = insertCalculation.run(
        new Date().toISOString(),
        payload.origen,
        payload.cantidadDisponible,
        payload.tipoCantidad,
        payload.cantidadProductos,
        payload.costoTotal,
        payload.ventaTotal,
        payload.gananciaEstimada,
        payload.margenGanancia,
        payload.saldoRestante
      );
      const calculoId = result.lastInsertRowid;
      payload.productos.forEach(producto => {
        insertProduct.run(
          calculoId,
          producto.name,
          producto.qty,
          producto.costUnit,
          producto.priceUnit,
          producto.costTotal,
          producto.saleTotal,
          producto.gananciaEstimada,
          producto.margenGanancia
        );
      });
      return calculoId;
    });

    const calculoId = tx();
    const row = db.prepare('SELECT * FROM calculadora_calculos WHERE id = ?').get(calculoId);
    return res.status(201).json({ ok: true, calculo: mapCalculatorRow(row) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo guardar el cálculo' });
  }
});

router.get('/calculadora', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM calculadora_calculos ORDER BY id DESC').all();
    return res.json({ ok: true, calculos: rows.map(mapCalculatorRow) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron cargar los cálculos' });
  }
});

router.get('/calculadora/draft', requireAuth, async (req, res) => {
  try {
    const parsed = await readConfigJson(CALCULATOR_DRAFT_KEY);
    if (!parsed) {
      return res.json({ ok: true, draft: null });
    }

    return res.json({ ok: true, draft: normalizeCalculatorDraft(parsed) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo cargar el borrador de calculadora' });
  }
});

router.put('/calculadora/draft', requireAuth, async (req, res) => {
  try {
    const incomingDraft = normalizeCalculatorDraft(req.body?.draft ?? req.body ?? {});
    const currentDraft = normalizeCalculatorDraft((await readConfigJson(CALCULATOR_DRAFT_KEY)) || {});
    const allowEmptyOverride = Boolean(req.body?.allowEmptyOverride);

    const incomingHasMeaningful = hasMeaningfulDraftProducts(incomingDraft);
    const currentHasMeaningful = hasMeaningfulDraftProducts(currentDraft);

    if (!allowEmptyOverride && !incomingHasMeaningful && currentHasMeaningful) {
      return res.json({ ok: true, draft: currentDraft, ignoredEmptyDraft: true });
    }

    if (Number(incomingDraft.updatedAt || 0) < Number(currentDraft.updatedAt || 0)) {
      return res.json({ ok: true, draft: currentDraft, ignoredStaleDraft: true });
    }

    await writeConfigJson(CALCULATOR_DRAFT_KEY, incomingDraft);
    return res.json({ ok: true, draft: incomingDraft });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo guardar el borrador de calculadora' });
  }
});

router.get('/calculadora/:id', requireAuth, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, message: 'ID inválido' });
    }

    const row = db.prepare('SELECT * FROM calculadora_calculos WHERE id = ?').get(id);
    if (!row) {
      return res.status(404).json({ ok: false, message: 'Cálculo no encontrado' });
    }

    return res.json({ ok: true, calculo: mapCalculatorRow(row) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo consultar el cálculo' });
  }
});

router.put('/calculadora/:id', requireAuth, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, message: 'ID inválido' });
    }

    const payload = normalizeCalculatorPayload(req.body || {});
    const updateCalculation = db.prepare(`
      UPDATE calculadora_calculos
      SET origen = ?, cantidad_disponible = ?, tipo_cantidad = ?, cantidad_productos = ?, costo_total = ?, venta_total = ?, ganancia_estimada = ?, margen_ganancia = ?, saldo_restante = ?
      WHERE id = ?
    `);
    const deleteProducts = db.prepare('DELETE FROM calculadora_productos WHERE calculo_id = ?');
    const insertProduct = db.prepare(`
      INSERT INTO calculadora_productos (
        calculo_id, nombre, cantidad, costo_unitario, precio_venta_unitario, costo_total, venta_total, ganancia_estimada, margen_ganancia
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      updateCalculation.run(
        payload.origen,
        payload.cantidadDisponible,
        payload.tipoCantidad,
        payload.cantidadProductos,
        payload.costoTotal,
        payload.ventaTotal,
        payload.gananciaEstimada,
        payload.margenGanancia,
        payload.saldoRestante,
        id
      );
      deleteProducts.run(id);
      payload.productos.forEach(producto => {
        insertProduct.run(
          id,
          producto.name,
          producto.qty,
          producto.costUnit,
          producto.priceUnit,
          producto.costTotal,
          producto.saleTotal,
          producto.gananciaEstimada,
          producto.margenGanancia
        );
      });
    });

    tx();
    const row = db.prepare('SELECT * FROM calculadora_calculos WHERE id = ?').get(id);
    return res.json({ ok: true, calculo: mapCalculatorRow(row) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo actualizar el cálculo' });
  }
});

router.delete('/calculadora/:id', requireAuth, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, message: 'ID inválido' });
    }

    const result = db.prepare('DELETE FROM calculadora_calculos WHERE id = ?').run(id);
    if (!result.changes) {
      return res.status(404).json({ ok: false, message: 'Cálculo no encontrado' });
    }

    return res.json({ ok: true, deletedId: id });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo eliminar el cálculo' });
  }
});

router.get('/public-promotions', async (req, res) => {
  try {
    const promotions = await readPromotions();
    return res.json({ ok: true, promotions });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron cargar promociones' });
  }
});

router.get('/public-settings', async (req, res) => {
  try {
    return res.json({
      ok: true,
      settings: {
        content: await readContent(),
        promotions: await readPromotions(),
        products: await readProducts()
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron cargar ajustes globales' });
  }
});

router.get('/public-settings/stream', (req, res) => {
  attachPublicSettingsClient(req, res);
});

router.get('/events', requireAuth, (req, res) => {
  attachAdminEventClient(req, res);
});

router.get('/promotions', requireAuth, async (req, res) => {
  try {
    const promotions = await readPromotions();
    return res.json({ ok: true, promotions });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron cargar promociones' });
  }
});

router.put('/promotions', requireAuth, async (req, res) => {
  try {
    const promotions = normalizePromotions(req.body?.promotions);
    await writePromotions(promotions);
    broadcastPublicSettingsEvent('promotions-updated', { ts: Date.now() });
    return res.json({ ok: true, promotions });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron guardar promociones' });
  }
});

router.get('/content', requireAuth, async (req, res) => {
  try {
    const content = await readContent();
    return res.json({ ok: true, content });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo cargar el contenido' });
  }
});

router.put('/content', requireAuth, async (req, res) => {
  try {
    const content = normalizeContent(req.body?.content);
    await writeContent(content);
    broadcastPublicSettingsEvent('content-updated', { ts: Date.now() });
    return res.json({ ok: true, content });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo guardar el contenido' });
  }
});

router.get('/public-products', async (req, res) => {
  try {
    const products = await readProducts();
    return res.json({ ok: true, products });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron cargar productos' });
  }
});

router.get('/products', requireAuth, async (req, res) => {
  try {
    const products = await readProducts();
    return res.json({ ok: true, products });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron cargar productos' });
  }
});

router.get('/sold-products', requireAuth, async (req, res) => {
  try {
    const requestedStart = sanitizeText(req.query?.startDate || '', 10);
    const requestedEnd = sanitizeText(req.query?.endDate || '', 10);
    const todayKey = getMexicoCityDateKey();
    const startDate = requestedStart || todayKey;
    const endDate = requestedEnd || startDate;

    if (!isValidDateKey(startDate) || !isValidDateKey(endDate)) {
      return res.status(400).json({ ok: false, message: 'Fechas invalidas. Usa formato YYYY-MM-DD' });
    }

    if (startDate > endDate) {
      return res.status(400).json({ ok: false, message: 'La fecha inicial no puede ser posterior a la fecha final' });
    }

    const startRange = buildUtcRangeFromDateKey(startDate, MEXICO_CITY_TZ_OFFSET_MINUTES);
    const endRange = buildUtcRangeFromDateKey(endDate, MEXICO_CITY_TZ_OFFSET_MINUTES);

    const rows = await queryAll(`
      SELECT productos, fecha
      FROM pedidos
      WHERE fecha >= ?
        AND fecha < ?
        AND estado != 'Cancelado'
      ORDER BY fecha DESC, id DESC
    `, [startRange.startIso, endRange.endIso]);

    const archivedRows = await queryAll(`
      SELECT productos, fecha
      FROM pedidos_archivados
      WHERE fecha >= ?
        AND fecha <= ?
        AND estado != 'Cancelado'
      ORDER BY fecha DESC, id DESC
    `, [startDate, endDate]);

    const allRows = [...rows, ...archivedRows];

    const aggregate = new Map();
    allRows.forEach(row => {
      const rawDate = String(row?.fecha || '').slice(0, 10);
      const shouldInclude = (!rawDate || rawDate >= startDate) && (!rawDate || rawDate <= endDate);
      if (!shouldInclude) return;

      parseProductos(row.productos).forEach(item => {
        const name = sanitizeText(item?.name || '', 140);
        const quantity = Math.max(0, Number(item?.qty || 0));
        const unitPrice = Math.max(0, Number(item?.price || 0));
        if (!name || quantity <= 0) return;

        const totalAmount = roundMoney(quantity * unitPrice);
        const current = aggregate.get(name) || {
          name,
          quantitySold: 0,
          totalAmount: 0
        };

        current.quantitySold += quantity;
        current.totalAmount = roundMoney(current.totalAmount + totalAmount);
        aggregate.set(name, current);
      });
    });

    const items = Array.from(aggregate.values())
      .map(item => ({
        name: item.name,
        quantitySold: Number(item.quantitySold || 0),
        unitPrice: item.quantitySold > 0 ? roundMoney(item.totalAmount / item.quantitySold) : 0,
        totalAmount: roundMoney(item.totalAmount)
      }))
      .sort((a, b) => {
        if (b.totalAmount !== a.totalAmount) return b.totalAmount - a.totalAmount;
        return a.name.localeCompare(b.name, 'es');
      });

    const summary = items.reduce((acc, item) => {
      acc.differentProducts += 1;
      acc.totalUnits += Number(item.quantitySold || 0);
      acc.totalRevenue = roundMoney(acc.totalRevenue + Number(item.totalAmount || 0));
      return acc;
    }, {
      differentProducts: 0,
      totalUnits: 0,
      totalRevenue: 0
    });

    return res.json({
      ok: true,
      period: {
        startDate,
        endDate,
        timezone: 'America/Mexico_City'
      },
      separatedNames: await readSoldProductsSeparated(),
      items,
      summary
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron calcular los productos vendidos' });
  }
});

router.put('/sold-products/separated', requireAuth, async (req, res) => {
  try {
    const separatedNames = await writeSoldProductsSeparated(req.body?.names);
    broadcastAdminEvent('sold-products-separation-updated', { ts: Date.now() });
    return res.json({ ok: true, separatedNames });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo guardar la separación de productos vendidos' });
  }
});

router.put('/products', requireAuth, async (req, res) => {
  try {
    const products = normalizeProducts(req.body?.products);
    await writeProducts(products);
    broadcastPublicSettingsEvent('products-updated', { ts: Date.now() });
    return res.json({ ok: true, products });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron guardar productos' });
  }
});

router.get('/stats', requireAuth, (req, res) => {
  try {
    maybeArchiveAndResetDailyOrders();
    const date = sanitizeText(req.query?.date || '', 10);
    const tzOffset = Number(req.query?.tzOffset);
    const effectiveDate = isValidDateKey(date) ? date : new Date().toISOString().slice(0, 10);
    const dayRange = buildUtcRangeFromDateKey(effectiveDate, tzOffset);
    const monthRange = buildUtcMonthRangeFromDateKey(effectiveDate, tzOffset);

    const totalPedidos = db.prepare('SELECT COUNT(*) AS count FROM pedidos WHERE fecha >= ? AND fecha < ?').get(dayRange.startIso, dayRange.endIso).count;
    const pendientes = db.prepare("SELECT COUNT(*) AS count FROM pedidos WHERE fecha >= ? AND fecha < ? AND estado IN ('Pendiente', 'Confirmado', 'Preparando', 'En camino')").get(dayRange.startIso, dayRange.endIso).count;
    const entregados = db.prepare("SELECT COUNT(*) AS count FROM pedidos WHERE fecha >= ? AND fecha < ? AND estado = 'Entregado'").get(dayRange.startIso, dayRange.endIso).count;

    const ventasHoy = db.prepare(`
      SELECT COALESCE(SUM(total), 0) AS total
      FROM pedidos
      WHERE fecha >= ?
        AND fecha < ?
        AND estado != 'Cancelado'
    `).get(dayRange.startIso, dayRange.endIso).total;

    const ventasMes = db.prepare(`
      SELECT COALESCE(SUM(total), 0) AS total
      FROM pedidos
      WHERE fecha >= ?
        AND fecha < ?
        AND estado != 'Cancelado'
    `).get(monthRange.startIso, monthRange.endIso).total;

    const totalVendido = db.prepare(`
      SELECT COALESCE(SUM(total), 0) AS total
      FROM pedidos
      WHERE fecha >= ?
        AND fecha < ?
        AND estado != 'Cancelado'
    `).get(dayRange.startIso, dayRange.endIso).total;

    const promedioPedido = totalPedidos > 0 ? Number(totalVendido) / Number(totalPedidos) : 0;

    const rows = db.prepare('SELECT productos FROM pedidos WHERE fecha >= ? AND fecha < ? AND estado != \'Cancelado\'').all(dayRange.startIso, dayRange.endIso);
    const productCount = new Map();

    rows.forEach(row => {
      parseProductos(row.productos).forEach(item => {
        const name = String(item?.name || '').trim();
        const qty = Number(item?.qty || 0);
        if (!name || !qty) return;
        productCount.set(name, (productCount.get(name) || 0) + qty);
      });
    });

    let productoMasVendido = '';
    let productoCantidad = 0;
    for (const [name, qty] of productCount.entries()) {
      if (qty > productoCantidad) {
        productoMasVendido = name;
        productoCantidad = qty;
      }
    }

    return res.json({
      ok: true,
      stats: {
        totalPedidos: Number(totalPedidos),
        pedidosPendientes: Number(pendientes),
        pedidosEntregados: Number(entregados),
        ventasDia: Number(ventasHoy || 0),
        ventasMes: Number(ventasMes || 0),
        totalVendido: Number(totalVendido || 0),
        promedioPorPedido: Number(promedioPedido || 0),
        productoMasVendido: productoMasVendido || 'Sin datos',
        productoMasVendidoCantidad: Number(productoCantidad || 0)
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron calcular estadisticas' });
  }
});

module.exports = router;
