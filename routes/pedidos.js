const express = require('express');
const { randomUUID } = require('crypto');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_ESTADOS = new Set([
  'Pendiente',
  'Confirmado',
  'Preparando',
  'En camino',
  'Entregado',
  'Cancelado'
]);

function isValidDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function sanitizeText(value, maxLength = 200) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function sanitizeMultiline(value, maxLength = 500) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, maxLength);
}

function toMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.round(num * 100) / 100;
}

function normalizeEstado(value) {
  const estado = sanitizeText(value, 30);
  return ALLOWED_ESTADOS.has(estado) ? estado : 'Pendiente';
}

function normalizeProductos(productos) {
  if (Array.isArray(productos)) {
    return productos
      .map(item => {
        const qty = Number(item?.qty) || 0;
        const name = sanitizeText(item?.name || '', 120);
        if (!qty || !name) return null;
        return {
          qty,
          name,
          price: toMoney(item?.price),
          productId: sanitizeText(item?.productId || '', 80),
          optionId: sanitizeText(item?.optionId || '', 80),
          choice: sanitizeText(item?.choice || '', 80)
        };
      })
      .filter(Boolean);
  }

  if (typeof productos === 'string' && productos.trim()) {
    return [{ qty: 1, name: sanitizeMultiline(productos, 300), price: 0 }];
  }

  return [];
}

function buildCreatePayload(body) {
  const clienteToken = sanitizeText(body?.clienteToken || body?.clientToken || '', 80) || randomUUID();
  const cliente = sanitizeText(body?.cliente || body?.name || '', 120);
  const telefono = sanitizeText(body?.telefono || body?.phone || '', 30);
  const direccion = sanitizeMultiline(body?.direccion || body?.address || '', 220);
  const tipoEntrega = sanitizeText(body?.tipoEntrega || body?.deliveryType || '', 50);
  const productos = normalizeProductos(body?.productos || body?.items || []);
  const subtotal = toMoney(body?.subtotal ?? body?.total ?? 0);
  const envio = toMoney(body?.envio ?? 0);
  const total = toMoney(body?.total ?? subtotal + envio);
  const estado = normalizeEstado(body?.estado || 'Pendiente');
  const fecha = body?.fecha && !Number.isNaN(Date.parse(body.fecha)) ? new Date(body.fecha).toISOString() : new Date().toISOString();

  return {
    clienteToken,
    cliente,
    telefono,
    direccion,
    tipoEntrega,
    productos,
    subtotal,
    envio,
    total,
    estado,
    fecha
  };
}

function mapPedido(row) {
  return {
    id: row.id,
    clienteToken: row.clienteToken || '',
    cliente: row.cliente,
    telefono: row.telefono || '',
    direccion: row.direccion || '',
    tipoEntrega: row.tipoEntrega,
    productos: JSON.parse(row.productos || '[]'),
    subtotal: Number(row.subtotal || 0),
    envio: Number(row.envio || 0),
    total: Number(row.total || 0),
    estado: row.estado,
    fecha: row.fecha
  };
}

router.post('/', (req, res) => {
  try {
    const payload = buildCreatePayload(req.body);

    if (!payload.cliente) {
      return res.status(400).json({ ok: false, message: 'El cliente es obligatorio' });
    }

    if (!payload.tipoEntrega) {
      return res.status(400).json({ ok: false, message: 'El tipo de entrega es obligatorio' });
    }

    if (!payload.productos.length) {
      return res.status(400).json({ ok: false, message: 'Debes incluir al menos un producto' });
    }

    const stmt = db.prepare(`
      INSERT INTO pedidos (
        clienteToken, cliente, telefono, direccion, tipoEntrega, productos, subtotal, envio, total, estado, fecha
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      payload.clienteToken,
      payload.cliente,
      payload.telefono,
      payload.direccion,
      payload.tipoEntrega,
      JSON.stringify(payload.productos),
      payload.subtotal,
      payload.envio,
      payload.total,
      payload.estado,
      payload.fecha
    );

    const created = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(result.lastInsertRowid);
    return res.status(201).json({ ok: true, pedido: mapPedido(created) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo guardar el pedido' });
  }
});

router.get('/', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM pedidos ORDER BY datetime(fecha) DESC, id DESC').all();
    return res.json({ ok: true, pedidos: rows.map(mapPedido) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron listar los pedidos' });
  }
});

router.get('/public', (req, res) => {
  try {
    const clienteToken = sanitizeText(req.query?.clienteToken || '', 80);
    if (!clienteToken) {
      return res.json({ ok: true, pedidos: [] });
    }

    const rows = db
      .prepare('SELECT * FROM pedidos WHERE clienteToken = ? ORDER BY datetime(fecha) DESC, id DESC LIMIT 100')
      .all(clienteToken);
    return res.json({ ok: true, pedidos: rows.map(mapPedido) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron listar los pedidos' });
  }
});

router.get('/day/export/csv', requireAuth, (req, res) => {
  try {
    const date = sanitizeText(req.query?.date || '', 10);
    if (!isValidDateKey(date)) {
      return res.status(400).json({ ok: false, message: 'Fecha invalida. Usa formato YYYY-MM-DD' });
    }

    const rows = db
      .prepare('SELECT * FROM pedidos WHERE SUBSTR(fecha, 1, 10) = ? ORDER BY datetime(fecha) DESC, id DESC')
      .all(date);

    const header = ['ID', 'Cliente', 'Telefono', 'Direccion', 'Entrega', 'Productos', 'Subtotal', 'Envio', 'Total', 'Estado', 'Fecha'];
    const csvRows = [header.join(',')];

    rows.forEach(row => {
      const parsed = JSON.parse(row.productos || '[]');
      const productosTexto = parsed.map(item => `${item.qty || 1}x ${String(item.name || '').replace(/,/g, ' ')}`).join(' | ');
      const values = [
        row.id,
        row.cliente,
        row.telefono || '',
        row.direccion || '',
        row.tipoEntrega,
        productosTexto,
        Number(row.subtotal || 0).toFixed(2),
        Number(row.envio || 0).toFixed(2),
        Number(row.total || 0).toFixed(2),
        row.estado,
        row.fecha
      ].map(value => `"${String(value).replace(/"/g, '""')}"`);

      csvRows.push(values.join(','));
    });

    const csv = `\uFEFF${csvRows.join('\n')}`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pedidos-${date}.csv"`);
    return res.send(csv);
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo exportar el CSV del dia' });
  }
});

router.delete('/day', requireAuth, (req, res) => {
  try {
    const date = sanitizeText(req.query?.date || '', 10);
    if (!isValidDateKey(date)) {
      return res.status(400).json({ ok: false, message: 'Fecha invalida. Usa formato YYYY-MM-DD' });
    }

    const rows = db
      .prepare('SELECT * FROM pedidos WHERE SUBSTR(fecha, 1, 10) = ? ORDER BY datetime(fecha) DESC, id DESC')
      .all(date);

    const result = db.prepare('DELETE FROM pedidos WHERE SUBSTR(fecha, 1, 10) = ?').run(date);

    const remaining = db.prepare('SELECT id FROM pedidos LIMIT 1').get();
    if (!remaining) {
      db.prepare("DELETE FROM sqlite_sequence WHERE name = 'pedidos'").run();
    }

    return res.json({
      ok: true,
      deletedCount: Number(result.changes || 0),
      date,
      deletedOrders: rows.map(mapPedido)
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron eliminar pedidos del dia' });
  }
});

router.post('/day/restore', requireAuth, (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.orders) ? req.body.orders : [];
    if (!incoming.length) {
      return res.status(400).json({ ok: false, message: 'No hay pedidos para restaurar' });
    }

    const prepared = incoming
      .map(order => {
        const payload = buildCreatePayload({
          clienteToken: order?.clienteToken,
          cliente: order?.cliente,
          telefono: order?.telefono,
          direccion: order?.direccion,
          tipoEntrega: order?.tipoEntrega,
          productos: order?.productos,
          subtotal: order?.subtotal,
          envio: order?.envio,
          total: order?.total,
          estado: order?.estado,
          fecha: order?.fecha
        });

        if (!payload.cliente || !payload.tipoEntrega || !payload.productos.length) {
          return null;
        }

        return payload;
      })
      .filter(Boolean);

    if (!prepared.length) {
      return res.status(400).json({ ok: false, message: 'Los pedidos a restaurar son invalidos' });
    }

    const insert = db.prepare(`
      INSERT INTO pedidos (
        clienteToken, cliente, telefono, direccion, tipoEntrega, productos, subtotal, envio, total, estado, fecha
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(rows => {
      rows.forEach(payload => {
        insert.run(
          payload.clienteToken,
          payload.cliente,
          payload.telefono,
          payload.direccion,
          payload.tipoEntrega,
          JSON.stringify(payload.productos),
          payload.subtotal,
          payload.envio,
          payload.total,
          payload.estado,
          payload.fecha
        );
      });
    });

    tx(prepared);

    return res.json({ ok: true, restoredCount: prepared.length });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudieron restaurar pedidos del dia' });
  }
});

router.get('/:id', requireAuth, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, message: 'ID invalido' });
    }

    const row = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(id);
    if (!row) {
      return res.status(404).json({ ok: false, message: 'Pedido no encontrado' });
    }

    return res.json({ ok: true, pedido: mapPedido(row) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo consultar el pedido' });
  }
});

router.put('/:id', requireAuth, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, message: 'ID invalido' });
    }

    const estado = normalizeEstado(req.body?.estado);
    if (!ALLOWED_ESTADOS.has(estado)) {
      return res.status(400).json({ ok: false, message: 'Estado invalido' });
    }

    const result = db.prepare('UPDATE pedidos SET estado = ? WHERE id = ?').run(estado, id);
    if (!result.changes) {
      return res.status(404).json({ ok: false, message: 'Pedido no encontrado' });
    }

    const row = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(id);
    return res.json({ ok: true, pedido: mapPedido(row) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo actualizar el pedido' });
  }
});

router.delete('/:id', requireAuth, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, message: 'ID invalido' });
    }

    const result = db.prepare('DELETE FROM pedidos WHERE id = ?').run(id);
    if (!result.changes) {
      return res.status(404).json({ ok: false, message: 'Pedido no encontrado' });
    }

    const remaining = db.prepare('SELECT id FROM pedidos LIMIT 1').get();
    if (!remaining) {
      db.prepare("DELETE FROM sqlite_sequence WHERE name = 'pedidos'").run();
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo eliminar el pedido' });
  }
});

router.get('/export/csv/all', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM pedidos ORDER BY datetime(fecha) DESC, id DESC').all();
    const header = ['ID', 'Cliente', 'Telefono', 'Direccion', 'Entrega', 'Productos', 'Subtotal', 'Envio', 'Total', 'Estado', 'Fecha'];
    const csvRows = [header.join(',')];

    rows.forEach(row => {
      const parsed = JSON.parse(row.productos || '[]');
      const productosTexto = parsed.map(item => `${item.qty || 1}x ${String(item.name || '').replace(/,/g, ' ')}`).join(' | ');
      const values = [
        row.id,
        row.cliente,
        row.telefono || '',
        row.direccion || '',
        row.tipoEntrega,
        productosTexto,
        Number(row.subtotal || 0).toFixed(2),
        Number(row.envio || 0).toFixed(2),
        Number(row.total || 0).toFixed(2),
        row.estado,
        row.fecha
      ].map(value => `"${String(value).replace(/"/g, '""')}"`);

      csvRows.push(values.join(','));
    });

    const csv = `\uFEFF${csvRows.join('\n')}`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pedidos-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.send(csv);
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo exportar el CSV' });
  }
});

module.exports = {
  router,
  ALLOWED_ESTADOS
};
