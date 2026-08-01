const express = require('express');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const PROMOS_KEY = 'site_promotions_v1';
const PRODUCTS_KEY = 'site_products_v1';
const CONTENT_KEY = 'site_content_v1';

function parseProductos(raw) {
  try {
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

function sanitizeText(value, maxLength = 220) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, maxLength);
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

      if (!id || !title || !text) return null;
      return { id, title, text, chip, active };
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

function readPromotions() {
  const row = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(PROMOS_KEY);
  if (!row?.valor) return [];
  try {
    return normalizePromotions(JSON.parse(row.valor));
  } catch {
    return [];
  }
}

function writePromotions(promotions) {
  db.prepare(`
    INSERT INTO configuracion (clave, valor)
    VALUES (?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor
  `).run(PROMOS_KEY, JSON.stringify(promotions));
}

function readProducts() {
  const row = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(PRODUCTS_KEY);
  if (!row?.valor) return [];
  try {
    return normalizeProducts(JSON.parse(row.valor));
  } catch {
    return [];
  }
}

function writeProducts(products) {
  db.prepare(`
    INSERT INTO configuracion (clave, valor)
    VALUES (?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor
  `).run(PRODUCTS_KEY, JSON.stringify(products));
}

function readContent() {
  const row = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(CONTENT_KEY);
  if (!row?.valor) return null;
  try {
    return normalizeContent(JSON.parse(row.valor));
  } catch {
    return null;
  }
}

function writeContent(content) {
  db.prepare(`
    INSERT INTO configuracion (clave, valor)
    VALUES (?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor
  `).run(CONTENT_KEY, JSON.stringify(content));
}

router.get('/public-promotions', (req, res) => {
  try {
    return res.json({ ok: true, promotions: readPromotions() });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron cargar promociones' });
  }
});

router.get('/public-settings', (req, res) => {
  try {
    return res.json({
      ok: true,
      settings: {
        content: readContent(),
        promotions: readPromotions(),
        products: readProducts()
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron cargar ajustes globales' });
  }
});

router.get('/promotions', requireAuth, (req, res) => {
  try {
    return res.json({ ok: true, promotions: readPromotions() });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron cargar promociones' });
  }
});

router.put('/promotions', requireAuth, (req, res) => {
  try {
    const promotions = normalizePromotions(req.body?.promotions);
    writePromotions(promotions);
    return res.json({ ok: true, promotions });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron guardar promociones' });
  }
});

router.get('/content', requireAuth, (req, res) => {
  try {
    return res.json({ ok: true, content: readContent() });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo cargar el contenido' });
  }
});

router.put('/content', requireAuth, (req, res) => {
  try {
    const content = normalizeContent(req.body?.content);
    writeContent(content);
    return res.json({ ok: true, content });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo guardar el contenido' });
  }
});

router.get('/public-products', (req, res) => {
  try {
    return res.json({ ok: true, products: readProducts() });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron cargar productos' });
  }
});

router.get('/products', requireAuth, (req, res) => {
  try {
    return res.json({ ok: true, products: readProducts() });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron cargar productos' });
  }
});

router.put('/products', requireAuth, (req, res) => {
  try {
    const products = normalizeProducts(req.body?.products);
    writeProducts(products);
    return res.json({ ok: true, products });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron guardar productos' });
  }
});

router.get('/stats', requireAuth, (req, res) => {
  try {
    const totalPedidos = db.prepare('SELECT COUNT(*) AS count FROM pedidos').get().count;
    const pendientes = db.prepare("SELECT COUNT(*) AS count FROM pedidos WHERE estado IN ('Pendiente', 'Confirmado', 'Preparando', 'En camino')").get().count;
    const entregados = db.prepare("SELECT COUNT(*) AS count FROM pedidos WHERE estado = 'Entregado'").get().count;

    const ventasHoy = db.prepare(`
      SELECT COALESCE(SUM(total), 0) AS total
      FROM pedidos
      WHERE DATE(fecha) = DATE('now', 'localtime')
        AND estado != 'Cancelado'
    `).get().total;

    const ventasMes = db.prepare(`
      SELECT COALESCE(SUM(total), 0) AS total
      FROM pedidos
      WHERE STRFTIME('%Y-%m', fecha) = STRFTIME('%Y-%m', 'now', 'localtime')
        AND estado != 'Cancelado'
    `).get().total;

    const totalVendido = db.prepare(`
      SELECT COALESCE(SUM(total), 0) AS total
      FROM pedidos
      WHERE estado != 'Cancelado'
    `).get().total;

    const promedioPedido = totalPedidos > 0 ? Number(totalVendido) / Number(totalPedidos) : 0;

    const rows = db.prepare("SELECT productos FROM pedidos WHERE estado != 'Cancelado'").all();
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
