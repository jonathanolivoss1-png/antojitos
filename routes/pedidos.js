const express = require('express');
const { randomUUID } = require('crypto');
const rawPgPool = require('../postgres');
const db = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { broadcastAdminEvent } = require('../realtime/events');

const router = express.Router();
let pgPool = rawPgPool;
const isPostgresReady = Boolean(rawPgPool);

function normalizeSqlForSqlite(sql) {
  return String(sql)
    .replace(/::timestamptz/gi, '')
    .replace(/::date/gi, '')
    .replace(/::jsonb/gi, '')
    .replace(/\bjsonb\b/gi, 'TEXT')
    .replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\s+FOR UPDATE/gi, '')
    .replace(/\$[0-9]+/g, '?')
    .replace(/\btrue\b/gi, '1')
    .replace(/\bfalse\b/gi, '0');
}

function getSqliteTableName(sql) {
  const normalized = String(sql).trim();
  const insertMatch = normalized.match(/INSERT\s+INTO\s+([\w]+)/i);
  if (insertMatch) return insertMatch[1];
  const updateMatch = normalized.match(/UPDATE\s+([\w]+)/i);
  if (updateMatch) return updateMatch[1];
  const deleteMatch = normalized.match(/DELETE\s+FROM\s+([\w]+)/i);
  if (deleteMatch) return deleteMatch[1];
  return null;
}

function sqliteQuery(sql, params = []) {
  const normalizedSql = normalizeSqlForSqlite(sql);
  const trimmed = normalizedSql.trim();
  const firstWord = trimmed.split(/\s+/)[0]?.toUpperCase();
  const hasReturning = /\bRETURNING\b/i.test(trimmed);
  const cleanSql = hasReturning ? trimmed.replace(/\bRETURNING\b[\s\S]*$/i, '').trim() : trimmed;

  if (firstWord === 'BEGIN' || firstWord === 'COMMIT' || firstWord === 'ROLLBACK') {
    db.exec(cleanSql);
    return { rows: [], rowCount: 0 };
  }

  const statement = db.prepare(cleanSql);

  if (firstWord === 'SELECT' || firstWord === 'PRAGMA') {
    return { rows: statement.all(...params) };
  }

  const info = statement.run(...params);
  const result = { rows: [], rowCount: info.changes, lastInsertRowid: info.lastInsertRowid };

  if (hasReturning) {
    const table = getSqliteTableName(trimmed);
    const rowId = firstWord === 'INSERT' ? info.lastInsertRowid : params[params.length - 1];
    if (table && rowId) {
      try {
        const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(rowId);
        if (row) result.rows = [row];
      } catch {
        // ignore fallback if select fails
      }
    }
  }

  return result;
}

function getSqliteClient() {
  return {
    query(sql, params = []) {
      return sqliteQuery(sql, params);
    },
    release() {
      // no-op for SQLite
    }
  };
}

function createSqlitePool() {
  return {
    query(sql, params = []) {
      return Promise.resolve(sqliteQuery(sql, params));
    },
    connect() {
      return Promise.resolve(getSqliteClient());
    }
  };
}

if (!pgPool) {
  pgPool = createSqlitePool();
}

const ALLOWED_ESTADOS = new Set([
  'Pendiente',
  'Confirmado',
  'Preparando',
  'En camino',
  'Entregado',
  'Cancelado'
]);

const EDITABLE_ESTADOS = new Set([
  'Confirmado',
  'Entregado',
  'Cancelado'
]);


const DAILY_ARCHIVE_STATE_KEY = 'daily_archive_state_v1';
const MEXICO_CITY_TZ_OFFSET_MINUTES = 360;

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

function getMexicoCityDateKey(date = new Date()) {
  const localMillis = date.getTime() - MEXICO_CITY_TZ_OFFSET_MINUTES * 60 * 1000;
  const localDate = new Date(localMillis);
  const year = localDate.getUTCFullYear();
  const month = String(localDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(localDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
        const qty = Number(item?.qty ?? item?.cantidad) || 0;
        if (!qty) return null;

        const name = sanitizeText(
          item?.name || item?.nombre || item?.choice || item?.optionLabel || 'Producto',
          120
        );

        return {
          qty,
          name,
          price: toMoney(item?.price ?? item?.precio),
          productId: sanitizeText(item?.productId || '', 80),
          optionId: sanitizeText(item?.optionId || item?.opcionId || '', 80),
          choice: sanitizeText(item?.choice || item?.opcion || '', 80)
        };
      })
      .filter(Boolean);
  }

  if (typeof productos === 'string' && productos.trim()) {
    return [{ qty: 1, name: sanitizeMultiline(productos, 300), price: 0 }];
  }

  return [];
}

function parseProductos(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeDate(value) {
  if (value instanceof Date) return value.toISOString();
  if (!value) return '';

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
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
  const estado = normalizeEstado(body?.estado || 'Confirmado');
  const fecha = body?.fecha && !Number.isNaN(Date.parse(body.fecha))
    ? new Date(body.fecha).toISOString()
    : new Date().toISOString();

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
    id: Number(row.id),
    clienteToken:
      row.cliente_token ||
      row.clientetoken ||
      row.clienteToken ||
      '',
    cliente: row.cliente,
    telefono: row.telefono || '',
    direccion: row.direccion || '',
    tipoEntrega:
      row.tipo_entrega ||
      row.tipoentrega ||
      row.tipoEntrega ||
      '',
    productos: parseProductos(row.productos),
    subtotal: Number(row.subtotal || 0),
    envio: Number(row.envio || 0),
    total: Number(row.total || 0),
    estado: row.estado,
    fecha: normalizeDate(
      row.fecha_original ||
      row.fecha
    )
  };
}

async function initializeOrdersTables() {
  if (isPostgresReady) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS configuracion (
        clave TEXT PRIMARY KEY,
        valor JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pedidos (
        id BIGSERIAL PRIMARY KEY,
        cliente_token TEXT NOT NULL DEFAULT '',
        cliente TEXT NOT NULL,
        telefono TEXT,
        direccion TEXT,
        tipo_entrega TEXT NOT NULL,
        productos JSONB NOT NULL DEFAULT '[]'::jsonb,
        subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
        envio NUMERIC(12, 2) NOT NULL DEFAULT 0,
        total NUMERIC(12, 2) NOT NULL DEFAULT 0,
        estado TEXT NOT NULL DEFAULT 'Pendiente',
        fecha TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS pedidos_archivados (
        id BIGSERIAL PRIMARY KEY,
        fecha DATE NOT NULL,
        fecha_original TIMESTAMPTZ,
        cliente_token TEXT NOT NULL DEFAULT '',
        cliente TEXT NOT NULL,
        telefono TEXT,
        direccion TEXT,
        tipo_entrega TEXT NOT NULL,
        productos JSONB NOT NULL DEFAULT '[]'::jsonb,
        subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
        envio NUMERIC(12, 2) NOT NULL DEFAULT 0,
        total NUMERIC(12, 2) NOT NULL DEFAULT 0,
        estado TEXT NOT NULL DEFAULT 'Pendiente',
        creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        origen_pedido_id BIGINT
      );

      ALTER TABLE pedidos_archivados
      ADD COLUMN IF NOT EXISTS fecha_original TIMESTAMPTZ;

      UPDATE pedidos_archivados
      SET fecha_original =
        (
          fecha::timestamp +
          INTERVAL '12 hours'
        ) AT TIME ZONE 'America/Mexico_City'
      WHERE fecha_original IS NULL;

      CREATE INDEX IF NOT EXISTS idx_pedidos_estado
        ON pedidos (estado);

      CREATE INDEX IF NOT EXISTS idx_pedidos_fecha
        ON pedidos (fecha DESC);

      CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_token
        ON pedidos (cliente_token);

      CREATE INDEX IF NOT EXISTS idx_pedidos_archivados_fecha
        ON pedidos_archivados (fecha DESC);

      CREATE INDEX IF NOT EXISTS idx_pedidos_archivados_cliente_token
        ON pedidos_archivados (cliente_token);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_archivados_origen
        ON pedidos_archivados (origen_pedido_id)
        WHERE origen_pedido_id IS NOT NULL;
    `);

    console.log('Tablas de pedidos verificadas en PostgreSQL.');
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS configuracion (
      clave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_token TEXT NOT NULL DEFAULT '',
      cliente TEXT NOT NULL,
      telefono TEXT,
      direccion TEXT,
      tipo_entrega TEXT NOT NULL DEFAULT 'Pendiente',
      productos TEXT NOT NULL DEFAULT '[]',
      subtotal REAL NOT NULL DEFAULT 0,
      envio REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'Pendiente',
      fecha TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pedidos_archivados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT NOT NULL,
      fecha_original TEXT,
      cliente_token TEXT NOT NULL DEFAULT '',
      cliente TEXT NOT NULL,
      telefono TEXT,
      direccion TEXT,
      tipo_entrega TEXT NOT NULL DEFAULT 'Pendiente',
      productos TEXT NOT NULL DEFAULT '[]',
      subtotal REAL NOT NULL DEFAULT 0,
      envio REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'Pendiente',
      creado_en TEXT NOT NULL,
      origen_pedido_id INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_pedidos_estado
      ON pedidos (estado);

    CREATE INDEX IF NOT EXISTS idx_pedidos_fecha
      ON pedidos (fecha DESC);

    CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_token
      ON pedidos (cliente_token);

    CREATE INDEX IF NOT EXISTS idx_pedidos_archivados_fecha
      ON pedidos_archivados (fecha DESC);

    CREATE INDEX IF NOT EXISTS idx_pedidos_archivados_cliente_token
      ON pedidos_archivados (cliente_token);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_archivados_origen
      ON pedidos_archivados (origen_pedido_id);
  `);

  const archivedColumns =
    db.prepare('PRAGMA table_info(pedidos_archivados)').all();

  const hasOriginalDate =
    archivedColumns.some(
      column => column.name === 'fecha_original'
    );

  if (!hasOriginalDate) {
    db.exec(`
      ALTER TABLE pedidos_archivados
      ADD COLUMN fecha_original TEXT
    `);
  }

  db.exec(`
    UPDATE pedidos_archivados
    SET fecha_original =
      CASE
        WHEN length(fecha) = 10
          THEN fecha || 'T12:00:00-06:00'
        ELSE fecha
      END
    WHERE fecha_original IS NULL
       OR fecha_original = ''
  `);

  console.log('Tablas de pedidos verificadas en SQLite.');
}

const ordersTablesReady = initializeOrdersTables().catch(error => {
  console.error('Error inicializando tablas de pedidos en PostgreSQL:', error.message);
  throw error;
});

async function waitForOrdersTables() {
  await ordersTablesReady;
}

async function readDailyArchiveState(queryable = pgPool) {
  const result = await queryable.query(
    'SELECT valor FROM configuracion WHERE clave = $1 LIMIT 1',
    [DAILY_ARCHIVE_STATE_KEY]
  );

  const value = result.rows[0]?.valor;
  if (!value) return { lastProcessedDate: null };

  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function writeDailyArchiveState(value, queryable = pgPool) {
  await queryable.query(
    `
      INSERT INTO configuracion (clave, valor)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (clave)
      DO UPDATE SET valor = EXCLUDED.valor
    `,
    [DAILY_ARCHIVE_STATE_KEY, JSON.stringify(value)]
  );
}

async function archiveOrdersForDate(
  dateKey,
  tzOffsetMinutes,
  reason = 'archived-day'
) {
  await waitForOrdersTables();

  if (!isValidDateKey(dateKey)) {
    return {
      archivedCount: 0,
      archivedOrders: []
    };
  }

  const range = buildUtcRangeFromDateKey(
    dateKey,
    tzOffsetMinutes
  );

  const client = await pgPool.connect();

  try {
    await client.query('BEGIN');

    const rowsResult = await client.query(
      `
        SELECT *
        FROM pedidos
        WHERE fecha >= $1::timestamptz
          AND fecha < $2::timestamptz
        ORDER BY fecha DESC, id DESC
        FOR UPDATE
      `,
      [range.startIso, range.endIso]
    );

    const rows = rowsResult.rows;

    const postgresInsertQuery = `
      INSERT INTO pedidos_archivados (
        fecha,
        fecha_original,
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
        creado_en,
        origen_pedido_id
      )
      VALUES (
        $1::date,
        $2::timestamptz,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8::jsonb,
        $9,
        $10,
        $11,
        $12,
        NOW(),
        $13
      )
      ON CONFLICT (origen_pedido_id)
      WHERE origen_pedido_id IS NOT NULL
      DO NOTHING
    `;

    const sqliteInsertQuery = `
      INSERT OR IGNORE INTO pedidos_archivados (
        fecha,
        fecha_original,
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
        creado_en,
        origen_pedido_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    for (const order of rows) {
      const params = [
        dateKey,
        normalizeDate(order.fecha),
        order.cliente_token || '',
        order.cliente || '',
        order.telefono || '',
        order.direccion || '',
        order.tipo_entrega || '',
        JSON.stringify(parseProductos(order.productos)),
        Number(order.subtotal || 0),
        Number(order.envio || 0),
        Number(order.total || 0),
        order.estado || 'Pendiente'
      ];

      if (isPostgresReady) {
        await client.query(
          postgresInsertQuery,
          [...params, order.id]
        );
      } else {
        await client.query(
          sqliteInsertQuery,
          [
            ...params,
            new Date().toISOString(),
            order.id
          ]
        );
      }
    }

    const deleteResult = await client.query(
      `
        DELETE FROM pedidos
        WHERE fecha >= $1::timestamptz
          AND fecha < $2::timestamptz
      `,
      [range.startIso, range.endIso]
    );

    await client.query('COMMIT');

    if (Number(deleteResult.rowCount || 0) > 0) {
      broadcastAdminEvent('orders-updated', {
        ts: Date.now(),
        reason
      });
    }

    return {
      archivedCount: Number(deleteResult.rowCount || 0),
      archivedOrders: rows.map(mapPedido)
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function maybeArchiveAndResetDailyOrders() {
  if (maybeArchiveAndResetDailyOrders.running) {
    return maybeArchiveAndResetDailyOrders.running;
  }

  const cycle = (async () => {
    await waitForOrdersTables();

    const todayKey = getMexicoCityDateKey();

    const datesResult = await pgPool.query(`
      SELECT fecha
      FROM pedidos
      ORDER BY fecha ASC
    `);

    const pendingDateKeys = Array.from(
      new Set(
        datesResult.rows
          .map(row => {
            const parsed = new Date(row.fecha);

            if (Number.isNaN(parsed.getTime())) {
              return '';
            }

            return getMexicoCityDateKey(parsed);
          })
          .filter(
            dateKey =>
              isValidDateKey(dateKey) &&
              dateKey < todayKey
          )
      )
    ).sort();

    let archivedCount = 0;

    for (const dateKey of pendingDateKeys) {
      const archived = await archiveOrdersForDate(
        dateKey,
        MEXICO_CITY_TZ_OFFSET_MINUTES,
        'auto-archived-day'
      );

      archivedCount += Number(archived.archivedCount || 0);
    }

    await writeDailyArchiveState({
      lastProcessedDate: todayKey,
      archivedDates: pendingDateKeys,
      updatedAt: new Date().toISOString()
    });

    return {
      archivedCount,
      archivedDates: pendingDateKeys,
      skipped: pendingDateKeys.length === 0,
      date: todayKey
    };
  })();

  maybeArchiveAndResetDailyOrders.running = cycle;

  try {
    return await cycle;
  } finally {
    maybeArchiveAndResetDailyOrders.running = null;
  }
}

router.post('/', async (req, res) => {
  try {
    await waitForOrdersTables();
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
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11::timestamptz)
        RETURNING *
      `,
      [
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
      ]
    );

    broadcastAdminEvent('orders-updated', { ts: Date.now(), reason: 'created' });
    return res.status(201).json({ ok: true, pedido: mapPedido(result.rows[0]) });
  } catch (error) {
    console.error('Error guardando pedido en PostgreSQL:', error);
    return res.status(500).json({ ok: false, message: 'No se pudo guardar el pedido' });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    await waitForOrdersTables();
    const result = await pgPool.query(
      'SELECT * FROM pedidos ORDER BY fecha DESC, id DESC'
    );
    return res.json({ ok: true, pedidos: result.rows.map(mapPedido) });
  } catch (error) {
    console.error('Error listando pedidos:', error);
    return res.status(500).json({ ok: false, message: 'No se pudieron listar los pedidos' });
  }
});

// === HISTORIAL_DIARIO_PATCH_V1: consulta de pedidos activos y archivados ===
router.get('/day', requireAuth, async (req, res) => {
  try {
    await maybeArchiveAndResetDailyOrders();

    const date = sanitizeText(req.query?.date || '', 10);

    if (!isValidDateKey(date)) {
      return res.status(400).json({
        ok: false,
        message: 'Fecha invalida. Usa formato YYYY-MM-DD'
      });
    }

    const range = buildUtcRangeFromDateKey(
      date,
      MEXICO_CITY_TZ_OFFSET_MINUTES
    );

    const [activeResult, archivedResult] = await Promise.all([
      pgPool.query(
        `
          SELECT *
          FROM pedidos
          WHERE fecha >= $1::timestamptz
            AND fecha < $2::timestamptz
          ORDER BY fecha DESC, id DESC
        `,
        [range.startIso, range.endIso]
      ),
      pgPool.query(
        `
          SELECT *
          FROM pedidos_archivados
          WHERE fecha = $1::date
          ORDER BY fecha_original DESC, id DESC
        `,
        [date]
      )
    ]);

    const activeOrders = activeResult.rows.map(row => ({
      ...mapPedido(row),
      archivado: false,
      pedidoOriginalId: Number(row.id)
    }));

    const archivedOrders = archivedResult.rows.map(row => ({
      ...mapPedido(row),
      archivado: true,
      pedidoOriginalId: Number(
        row.origen_pedido_id || row.id
      )
    }));

    const pedidos = [
      ...activeOrders,
      ...archivedOrders
    ].sort(
      (a, b) =>
        new Date(b.fecha).getTime() -
        new Date(a.fecha).getTime()
    );

    return res.json({
      ok: true,
      date,
      pedidos,
      resumen: {
        activos: activeOrders.length,
        archivados: archivedOrders.length,
        total: pedidos.length
      }
    });
  } catch (error) {
    console.error('Error listando pedidos del día:', error);

    return res.status(500).json({
      ok: false,
      message: 'No se pudieron listar los pedidos del dia'
    });
  }
});

router.get('/public', async (req, res) => {
  try {
    await waitForOrdersTables();
    await maybeArchiveAndResetDailyOrders();

    const clienteToken = sanitizeText(
      req.query?.clienteToken || '',
      80
    );

    if (!clienteToken) {
      return res.json({
        ok: true,
        pedidos: []
      });
    }

    const [activeResult, archivedResult] = await Promise.all([
      pgPool.query(
        `
          SELECT *
          FROM pedidos
          WHERE cliente_token = $1
          ORDER BY fecha DESC, id DESC
          LIMIT 100
        `,
        [clienteToken]
      ),
      pgPool.query(
        `
          SELECT *
          FROM pedidos_archivados
          WHERE cliente_token = $1
          ORDER BY fecha_original DESC, id DESC
          LIMIT 100
        `,
        [clienteToken]
      )
    ]);

    const pedidos = [
      ...activeResult.rows.map(row => ({
        ...mapPedido(row),
        archivado: false
      })),
      ...archivedResult.rows.map(row => ({
        ...mapPedido(row),
        archivado: true
      }))
    ]
      .sort(
        (a, b) =>
          new Date(b.fecha).getTime() -
          new Date(a.fecha).getTime()
      )
      .slice(0, 100);

    return res.json({
      ok: true,
      pedidos
    });
  } catch (error) {
    console.error('Error listando pedidos públicos:', error);

    return res.status(500).json({
      ok: false,
      message: 'No se pudieron listar los pedidos'
    });
  }
});

router.get('/day/export/csv', requireAuth, async (req, res) => {
  try {
    await maybeArchiveAndResetDailyOrders();

    const date = sanitizeText(req.query?.date || '', 10);

    if (!isValidDateKey(date)) {
      return res.status(400).json({
        ok: false,
        message: 'Fecha invalida. Usa formato YYYY-MM-DD'
      });
    }

    const range = buildUtcRangeFromDateKey(
      date,
      MEXICO_CITY_TZ_OFFSET_MINUTES
    );

    const [activeResult, archivedResult] = await Promise.all([
      pgPool.query(
        `
          SELECT *
          FROM pedidos
          WHERE fecha >= $1::timestamptz
            AND fecha < $2::timestamptz
          ORDER BY fecha DESC, id DESC
        `,
        [range.startIso, range.endIso]
      ),
      pgPool.query(
        `
          SELECT *
          FROM pedidos_archivados
          WHERE fecha = $1::date
          ORDER BY fecha_original DESC, id DESC
        `,
        [date]
      )
    ]);

    const rows = [
      ...activeResult.rows.map(row => ({
        ...row,
        archivado: false
      })),
      ...archivedResult.rows.map(row => ({
        ...row,
        archivado: true
      }))
    ];

    const header = [
      'ID',
      'Cliente',
      'Telefono',
      'Direccion',
      'Entrega',
      'Productos',
      'Subtotal',
      'Envio',
      'Total',
      'Estado',
      'Fecha',
      'Registro'
    ];

    const csvRows = [header.join(',')];

    rows.forEach(row => {
      const productosTexto = parseProductos(row.productos)
        .map(item => {
          const quantity = Number(
            item?.qty ??
            item?.cantidad ??
            1
          );
          const name =
            item?.name ||
            item?.nombre ||
            'Producto';

          return `${quantity}x ${String(name).replace(/,/g, ' ')}`;
        })
        .join(' | ');

      const pedido = mapPedido(row);
      const visibleId = row.archivado
        ? Number(row.origen_pedido_id || row.id)
        : Number(row.id);

      const values = [
        visibleId,
        pedido.cliente,
        pedido.telefono,
        pedido.direccion,
        pedido.tipoEntrega,
        productosTexto,
        pedido.subtotal.toFixed(2),
        pedido.envio.toFixed(2),
        pedido.total.toFixed(2),
        pedido.estado,
        pedido.fecha,
        row.archivado ? 'Archivado' : 'Activo'
      ].map(value =>
        `"${String(value ?? '').replace(/"/g, '""')}"`
      );

      csvRows.push(values.join(','));
    });

    const csv = `\uFEFF${csvRows.join('\n')}`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="pedidos-${date}.csv"`
    );

    return res.send(csv);
  } catch (error) {
    console.error('Error exportando pedidos del día:', error);

    return res.status(500).json({
      ok: false,
      message: 'No se pudo exportar el CSV del dia'
    });
  }
});

router.delete('/day', requireAuth, async (req, res) => {
  let client;

  try {
    await waitForOrdersTables();

    const date = sanitizeText(req.query?.date || '', 10);

    if (!isValidDateKey(date)) {
      return res.status(400).json({
        ok: false,
        message: 'Fecha invalida. Usa formato YYYY-MM-DD'
      });
    }

    const range = buildUtcRangeFromDateKey(
      date,
      MEXICO_CITY_TZ_OFFSET_MINUTES
    );

    client = await pgPool.connect();
    await client.query('BEGIN');

    const activeRowsResult = await client.query(
      `
        SELECT *
        FROM pedidos
        WHERE fecha >= $1::timestamptz
          AND fecha < $2::timestamptz
        ORDER BY fecha DESC, id DESC
        FOR UPDATE
      `,
      [range.startIso, range.endIso]
    );

    const archivedRowsResult = await client.query(
      `
        SELECT *
        FROM pedidos_archivados
        WHERE fecha = $1::date
        ORDER BY fecha_original DESC, id DESC
        FOR UPDATE
      `,
      [date]
    );

    const activeDeleteResult = await client.query(
      `
        DELETE FROM pedidos
        WHERE fecha >= $1::timestamptz
          AND fecha < $2::timestamptz
      `,
      [range.startIso, range.endIso]
    );

    const archivedDeleteResult = await client.query(
      `
        DELETE FROM pedidos_archivados
        WHERE fecha = $1::date
      `,
      [date]
    );

    await client.query('COMMIT');

    const deletedActiveOrders = activeRowsResult.rows.map(row => ({
      ...mapPedido(row),
      archivado: false,
      origenPedidoId: Number(row.id)
    }));

    const deletedArchivedOrders = archivedRowsResult.rows.map(row => ({
      ...mapPedido(row),
      archivado: true,
      origenPedidoId: Number(
        row.origen_pedido_id || row.id
      )
    }));

    const deletedOrders = [
      ...deletedActiveOrders,
      ...deletedArchivedOrders
    ];

    const activeDeletedCount = Number(
      activeDeleteResult.rowCount || 0
    );
    const archivedDeletedCount = Number(
      archivedDeleteResult.rowCount || 0
    );
    const deletedCount =
      activeDeletedCount + archivedDeletedCount;

    if (deletedCount > 0) {
      broadcastAdminEvent('orders-updated', {
        ts: Date.now(),
        reason: 'deleted-any-day',
        date,
        activeDeletedCount,
        archivedDeletedCount
      });
    }

    return res.json({
      ok: true,
      date,
      deletedCount,
      activeDeletedCount,
      archivedDeletedCount,
      deletedOrders
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }

    console.error('Error eliminando pedidos del día:', error);

    return res.status(500).json({
      ok: false,
      message: 'No se pudieron eliminar los pedidos del día'
    });
  } finally {
    client?.release();
  }
});

router.post('/day/archive-and-reset', requireAuth, async (req, res) => {
  try {
    const date = sanitizeText(req.body?.date || '', 10);
    const tzOffset = Number(req.body?.tzOffset);

    if (!isValidDateKey(date)) {
      return res.status(400).json({ ok: false, message: 'Fecha invalida. Usa formato YYYY-MM-DD' });
    }

    const archived = await archiveOrdersForDate(date, tzOffset, 'archived-day');

    return res.json({
      ok: true,
      archivedCount: archived.archivedCount,
      date,
      archivedOrders: archived.archivedOrders
    });
  } catch (error) {
    console.error('Error archivando pedidos del día:', error);
    return res.status(500).json({ ok: false, message: 'No se pudo guardar y reiniciar el dia' });
  }
});

// === ELIMINAR_CUALQUIER_DIA_PATCH_V1: restauración ===
router.post('/day/restore', requireAuth, async (req, res) => {
  let client;

  try {
    await waitForOrdersTables();

    const incoming = Array.isArray(req.body?.orders)
      ? req.body.orders
      : [];

    if (!incoming.length) {
      return res.status(400).json({
        ok: false,
        message: 'No hay pedidos para restaurar'
      });
    }

    const activeOrders = incoming.filter(
      order => !Boolean(order?.archivado)
    );
    const archivedOrders = incoming.filter(
      order => Boolean(order?.archivado)
    );

    client = await pgPool.connect();
    await client.query('BEGIN');

    let restoredActiveCount = 0;
    let restoredArchivedCount = 0;

    for (const order of activeOrders) {
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

      if (
        !payload.cliente ||
        !payload.tipoEntrega ||
        !payload.productos.length
      ) {
        continue;
      }

      const result = await client.query(
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
        `,
        [
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
        ]
      );

      restoredActiveCount += Number(result.rowCount || 0);
    }

    for (const order of archivedOrders) {
      const originalDate = normalizeDate(order?.fecha);
      const parsedOriginalDate = new Date(originalDate);

      if (Number.isNaN(parsedOriginalDate.getTime())) {
        continue;
      }

      const dateKey = getMexicoCityDateKey(parsedOriginalDate);

      const clienteToken = sanitizeText(
        order?.clienteToken || '',
        80
      );
      const cliente = sanitizeText(
        order?.cliente || '',
        120
      );
      const telefono = sanitizeText(
        order?.telefono || '',
        30
      );
      const direccion = sanitizeMultiline(
        order?.direccion || '',
        220
      );
      const tipoEntrega = sanitizeText(
        order?.tipoEntrega || '',
        50
      );
      const productos = normalizeProductos(
        order?.productos || []
      );
      const subtotal = toMoney(order?.subtotal || 0);
      const envio = toMoney(order?.envio || 0);
      const total = toMoney(order?.total || 0);
      const estado = normalizeEstado(
        order?.estado || 'Pendiente'
      );

      const origenPedidoId = Number(
        order?.origenPedidoId ||
        order?.pedidoOriginalId ||
        order?.id ||
        0
      );

      if (
        !isValidDateKey(dateKey) ||
        !cliente ||
        !tipoEntrega ||
        !productos.length
      ) {
        continue;
      }

      let result;

      if (isPostgresReady) {
        result = await client.query(
          `
            INSERT INTO pedidos_archivados (
              fecha,
              fecha_original,
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
              creado_en,
              origen_pedido_id
            )
            VALUES (
              $1::date,
              $2::timestamptz,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8::jsonb,
              $9,
              $10,
              $11,
              $12,
              NOW(),
              $13
            )
            ON CONFLICT (origen_pedido_id)
            WHERE origen_pedido_id IS NOT NULL
            DO NOTHING
          `,
          [
            dateKey,
            originalDate,
            clienteToken,
            cliente,
            telefono,
            direccion,
            tipoEntrega,
            JSON.stringify(productos),
            subtotal,
            envio,
            total,
            estado,
            origenPedidoId || null
          ]
        );
      } else {
        result = await client.query(
          `
            INSERT OR IGNORE INTO pedidos_archivados (
              fecha,
              fecha_original,
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
              creado_en,
              origen_pedido_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            dateKey,
            originalDate,
            clienteToken,
            cliente,
            telefono,
            direccion,
            tipoEntrega,
            JSON.stringify(productos),
            subtotal,
            envio,
            total,
            estado,
            new Date().toISOString(),
            origenPedidoId || null
          ]
        );
      }

      restoredArchivedCount += Number(result.rowCount || 0);
    }

    await client.query('COMMIT');

    const restoredCount =
      restoredActiveCount + restoredArchivedCount;

    if (restoredCount > 0) {
      broadcastAdminEvent('orders-updated', {
        ts: Date.now(),
        reason: 'restored-any-day',
        restoredActiveCount,
        restoredArchivedCount
      });
    }

    return res.json({
      ok: true,
      restoredCount,
      restoredActiveCount,
      restoredArchivedCount
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }

    console.error('Error restaurando pedidos:', error);

    return res.status(500).json({
      ok: false,
      message: 'No se pudieron restaurar los pedidos del día'
    });
  } finally {
    client?.release();
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    await waitForOrdersTables();
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, message: 'ID invalido' });
    }

    const result = await pgPool.query(
      'SELECT * FROM pedidos WHERE id = $1 LIMIT 1',
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ ok: false, message: 'Pedido no encontrado' });
    }

    return res.json({ ok: true, pedido: mapPedido(result.rows[0]) });
  } catch (error) {
    console.error('Error consultando pedido:', error);
    return res.status(500).json({ ok: false, message: 'No se pudo consultar el pedido' });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    await waitForOrdersTables();
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, message: 'ID invalido' });
    }

    const estadoSolicitado = sanitizeText(req.body?.estado || '', 30);
    if (!EDITABLE_ESTADOS.has(estadoSolicitado)) {
      return res.status(400).json({ ok: false, message: 'Solo se permite Confirmado, Entregado o Cancelado' });
    }

    const result = await pgPool.query(
      `
        UPDATE pedidos
        SET estado = $1
        WHERE id = $2
        RETURNING *
      `,
      [estadoSolicitado, id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ ok: false, message: 'Pedido no encontrado' });
    }

    broadcastAdminEvent('orders-updated', { ts: Date.now(), reason: 'status-updated' });
    return res.json({ ok: true, pedido: mapPedido(result.rows[0]) });
  } catch (error) {
    console.error('Error actualizando pedido:', error);
    return res.status(500).json({ ok: false, message: 'No se pudo actualizar el pedido' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await waitForOrdersTables();
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, message: 'ID invalido' });
    }

    const result = await pgPool.query(
      'DELETE FROM pedidos WHERE id = $1 RETURNING id',
      [id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ ok: false, message: 'Pedido no encontrado' });
    }

    broadcastAdminEvent('orders-updated', { ts: Date.now(), reason: 'deleted' });
    return res.json({ ok: true });
  } catch (error) {
    console.error('Error eliminando pedido:', error);
    return res.status(500).json({ ok: false, message: 'No se pudo eliminar el pedido' });
  }
});

router.get('/export/csv/all', requireAuth, async (req, res) => {
  try {
    await waitForOrdersTables();
    const result = await pgPool.query(
      'SELECT * FROM pedidos ORDER BY fecha DESC, id DESC'
    );

    const header = ['ID', 'Cliente', 'Telefono', 'Direccion', 'Entrega', 'Productos', 'Subtotal', 'Envio', 'Total', 'Estado', 'Fecha'];
    const csvRows = [header.join(',')];

    result.rows.forEach(row => {
      const pedido = mapPedido(row);
      const productosTexto = pedido.productos
        .map(item => `${item.qty || 1}x ${String(item.name || '').replace(/,/g, ' ')}`)
        .join(' | ');
      const values = [
        pedido.id,
        pedido.cliente,
        pedido.telefono,
        pedido.direccion,
        pedido.tipoEntrega,
        productosTexto,
        pedido.subtotal.toFixed(2),
        pedido.envio.toFixed(2),
        pedido.total.toFixed(2),
        pedido.estado,
        pedido.fecha
      ].map(value => `"${String(value).replace(/"/g, '""')}"`);

      csvRows.push(values.join(','));
    });

    const csv = `\uFEFF${csvRows.join('\n')}`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="pedidos-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    return res.send(csv);
  } catch (error) {
    console.error('Error exportando todos los pedidos:', error);
    return res.status(500).json({ ok: false, message: 'No se pudo exportar el CSV' });
  }
});

module.exports = {
  router,
  ALLOWED_ESTADOS,
  maybeArchiveAndResetDailyOrders,
  initializeOrdersTables
};