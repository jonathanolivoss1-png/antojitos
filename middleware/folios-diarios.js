// DAILY_FOLIOS_AND_HIDE_READY_V1
'use strict';

const pgPool = require('../postgres');
const db = require('../database/db');

const usePostgres = Boolean(pgPool);
let readyPromise = null;

function mexicoDateKey(value = new Date()) {
  const date = new Date(value);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Mexico_City',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(safe);
  const get = type => parts.find(item => item.type === type)?.value;
  return [get('year'), get('month'), get('day')].join('-');
}

function sqliteColumnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all()
    .some(item => item.name === column);
}

function addSqliteColumn(table, definition) {
  const column = String(definition).trim().split(/\s+/)[0];
  if (!sqliteColumnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

async function initializePostgres() {
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS pedidos_folios_diarios (
      fecha DATE PRIMARY KEY,
      ultimo_numero INTEGER NOT NULL
    );
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS folio_dia INTEGER;
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS fecha_folio DATE;
    ALTER TABLE pedidos_archivados ADD COLUMN IF NOT EXISTS folio_dia INTEGER;
    ALTER TABLE pedidos_archivados ADD COLUMN IF NOT EXISTS fecha_folio DATE;
  `);

  await pgPool.query(`
    WITH ranked AS (
      SELECT
        id,
        (fecha AT TIME ZONE 'America/Mexico_City')::date AS date_key,
        ROW_NUMBER() OVER (
          PARTITION BY (fecha AT TIME ZONE 'America/Mexico_City')::date
          ORDER BY fecha, id
        )::integer AS folio
      FROM pedidos
    )
    UPDATE pedidos AS target
    SET fecha_folio = ranked.date_key, folio_dia = ranked.folio
    FROM ranked
    WHERE ranked.id = target.id
      AND (target.folio_dia IS NULL OR target.fecha_folio IS NULL)
  `);

  await pgPool.query(`
    WITH ranked AS (
      SELECT
        id,
        COALESCE(
          (fecha_original AT TIME ZONE 'America/Mexico_City')::date,
          fecha::date
        ) AS date_key,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(
            (fecha_original AT TIME ZONE 'America/Mexico_City')::date,
            fecha::date
          )
          ORDER BY COALESCE(
            fecha_original,
            (fecha::timestamp + INTERVAL '12 hours')
              AT TIME ZONE 'America/Mexico_City'
          ), id
        )::integer AS folio
      FROM pedidos_archivados
    )
    UPDATE pedidos_archivados AS target
    SET fecha_folio = ranked.date_key, folio_dia = ranked.folio
    FROM ranked
    WHERE ranked.id = target.id
      AND (target.folio_dia IS NULL OR target.fecha_folio IS NULL)
  `);

  await pgPool.query(`
    INSERT INTO pedidos_folios_diarios (fecha, ultimo_numero)
    SELECT fecha_folio, MAX(folio_dia)
    FROM (
      SELECT fecha_folio, folio_dia FROM pedidos
      UNION ALL
      SELECT fecha_folio, folio_dia FROM pedidos_archivados
    ) AS all_orders
    WHERE fecha_folio IS NOT NULL AND folio_dia IS NOT NULL
    GROUP BY fecha_folio
    ON CONFLICT (fecha)
    DO UPDATE SET ultimo_numero = GREATEST(
      pedidos_folios_diarios.ultimo_numero,
      EXCLUDED.ultimo_numero
    )
  `);

  await pgPool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_folio_dia
      ON pedidos (fecha_folio, folio_dia)
      WHERE fecha_folio IS NOT NULL AND folio_dia IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_archivados_folio_dia
      ON pedidos_archivados (fecha_folio, folio_dia)
      WHERE fecha_folio IS NOT NULL AND folio_dia IS NOT NULL;
  `);

  await pgPool.query(`
    CREATE OR REPLACE FUNCTION asignar_folio_diario_pedido()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE
      target_date DATE;
      next_number INTEGER;
    BEGIN
      target_date := COALESCE(
        NEW.fecha_folio,
        (COALESCE(NEW.fecha, NOW()) AT TIME ZONE 'America/Mexico_City')::date
      );
      NEW.fecha_folio := target_date;
      IF NEW.folio_dia IS NULL THEN
        INSERT INTO pedidos_folios_diarios (fecha, ultimo_numero)
        VALUES (target_date, 1)
        ON CONFLICT (fecha)
        DO UPDATE SET ultimo_numero = pedidos_folios_diarios.ultimo_numero + 1
        RETURNING ultimo_numero INTO next_number;
        NEW.folio_dia := next_number;
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS trg_asignar_folio_diario_pedido ON pedidos;
    CREATE TRIGGER trg_asignar_folio_diario_pedido
    BEFORE INSERT ON pedidos
    FOR EACH ROW EXECUTE FUNCTION asignar_folio_diario_pedido();
  `);

  await pgPool.query(`
    CREATE OR REPLACE FUNCTION asignar_folio_diario_archivado()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE
      source_folio INTEGER;
      source_date DATE;
      target_date DATE;
      next_number INTEGER;
    BEGIN
      IF NEW.origen_pedido_id IS NOT NULL THEN
        SELECT folio_dia, fecha_folio INTO source_folio, source_date
        FROM pedidos WHERE id = NEW.origen_pedido_id LIMIT 1;
      END IF;
      NEW.folio_dia := COALESCE(NEW.folio_dia, source_folio);
      target_date := COALESCE(
        NEW.fecha_folio,
        source_date,
        (COALESCE(NEW.fecha_original, NOW())
          AT TIME ZONE 'America/Mexico_City')::date,
        NEW.fecha::date
      );
      NEW.fecha_folio := target_date;
      IF NEW.folio_dia IS NULL THEN
        INSERT INTO pedidos_folios_diarios (fecha, ultimo_numero)
        VALUES (target_date, 1)
        ON CONFLICT (fecha)
        DO UPDATE SET ultimo_numero = pedidos_folios_diarios.ultimo_numero + 1
        RETURNING ultimo_numero INTO next_number;
        NEW.folio_dia := next_number;
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS trg_asignar_folio_diario_archivado
      ON pedidos_archivados;
    CREATE TRIGGER trg_asignar_folio_diario_archivado
    BEFORE INSERT ON pedidos_archivados
    FOR EACH ROW EXECUTE FUNCTION asignar_folio_diario_archivado();
  `);
}

function initializeSqlite() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pedidos_folios_diarios (
      fecha TEXT PRIMARY KEY,
      ultimo_numero INTEGER NOT NULL
    );
  `);
  addSqliteColumn('pedidos', 'folio_dia INTEGER');
  addSqliteColumn('pedidos', 'fecha_folio TEXT');
  addSqliteColumn('pedidos_archivados', 'folio_dia INTEGER');
  addSqliteColumn('pedidos_archivados', 'fecha_folio TEXT');

  const active = db.prepare(`
    SELECT id, fecha, folio_dia, fecha_folio
    FROM pedidos ORDER BY fecha, id
  `).all().map(row => ({
    table: 'pedidos', id: Number(row.id), timestamp: row.fecha,
    dateKey: row.fecha_folio || mexicoDateKey(row.fecha),
    folio: Number(row.folio_dia || 0)
  }));

  const archived = db.prepare(`
    SELECT id, fecha, fecha_original, folio_dia, fecha_folio
    FROM pedidos_archivados
    ORDER BY COALESCE(fecha_original, fecha), id
  `).all().map(row => ({
    table: 'pedidos_archivados', id: Number(row.id),
    timestamp: row.fecha_original || `${row.fecha}T12:00:00-06:00`,
    dateKey: row.fecha_folio || mexicoDateKey(
      row.fecha_original || `${row.fecha}T12:00:00-06:00`
    ),
    folio: Number(row.folio_dia || 0)
  }));

  const all = [...active, ...archived].sort((a, b) =>
    a.dateKey.localeCompare(b.dateKey) ||
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime() ||
    a.table.localeCompare(b.table) || a.id - b.id
  );

  const counters = new Map();
  const updateActive = db.prepare(`
    UPDATE pedidos SET fecha_folio = ?, folio_dia = ? WHERE id = ?
  `);
  const updateArchived = db.prepare(`
    UPDATE pedidos_archivados SET fecha_folio = ?, folio_dia = ? WHERE id = ?
  `);
  const upsert = db.prepare(`
    INSERT INTO pedidos_folios_diarios (fecha, ultimo_numero)
    VALUES (?, ?)
    ON CONFLICT(fecha) DO UPDATE SET ultimo_numero = MAX(
      pedidos_folios_diarios.ultimo_numero,
      excluded.ultimo_numero
    )
  `);

  db.transaction(() => {
    for (const row of all) {
      const current = Number(counters.get(row.dateKey) || 0);
      const folio = row.folio > 0 ? row.folio : current + 1;
      counters.set(row.dateKey, Math.max(current, folio));
      const statement = row.table === 'pedidos' ? updateActive : updateArchived;
      statement.run(row.dateKey, folio, row.id);
    }
    for (const [dateKey, folio] of counters) upsert.run(dateKey, folio);
  })();

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_folio_dia
      ON pedidos (fecha_folio, folio_dia);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_archivados_folio_dia
      ON pedidos_archivados (fecha_folio, folio_dia);
    DROP TRIGGER IF EXISTS trg_asignar_folio_diario_pedido;
    CREATE TRIGGER trg_asignar_folio_diario_pedido
    AFTER INSERT ON pedidos WHEN NEW.folio_dia IS NULL
    BEGIN
      INSERT INTO pedidos_folios_diarios (fecha, ultimo_numero)
      VALUES (date(NEW.fecha, '-6 hours'), 1)
      ON CONFLICT(fecha) DO UPDATE SET ultimo_numero = ultimo_numero + 1;
      UPDATE pedidos
      SET fecha_folio = date(NEW.fecha, '-6 hours'),
          folio_dia = (
            SELECT ultimo_numero FROM pedidos_folios_diarios
            WHERE fecha = date(NEW.fecha, '-6 hours')
          )
      WHERE id = NEW.id;
    END;
    DROP TRIGGER IF EXISTS trg_asignar_folio_diario_archivado;
    CREATE TRIGGER trg_asignar_folio_diario_archivado
    AFTER INSERT ON pedidos_archivados WHEN NEW.folio_dia IS NULL
    BEGIN
      UPDATE pedidos_archivados
      SET folio_dia = (
            SELECT folio_dia FROM pedidos WHERE id = NEW.origen_pedido_id
          ),
          fecha_folio = COALESCE((
            SELECT fecha_folio FROM pedidos WHERE id = NEW.origen_pedido_id
          ), NEW.fecha)
      WHERE id = NEW.id;
    END;
  `);
}

async function initialize() {
  if (usePostgres) await initializePostgres();
  else initializeSqlite();
}

function ready() {
  if (!readyPromise) {
    readyPromise = initialize().catch(error => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}

function looksLikeOrder(value) {
  return Boolean(value && typeof value === 'object' &&
    Number.isInteger(Number(value.id)) &&
    (Object.prototype.hasOwnProperty.call(value, 'productos') ||
     Object.prototype.hasOwnProperty.call(value, 'tipoEntrega') ||
     Object.prototype.hasOwnProperty.call(value, 'tipo_entrega')));
}

function collect(value, orders, visited) {
  if (!value || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  if (looksLikeOrder(value)) orders.push(value);
  if (Array.isArray(value)) {
    value.forEach(item => collect(item, orders, visited));
  } else {
    Object.values(value).forEach(item => collect(item, orders, visited));
  }
}

async function rows(table, ids) {
  if (!ids.length) return [];
  if (usePostgres) {
    const result = await pgPool.query(`
      SELECT id, folio_dia, fecha_folio FROM ${table}
      WHERE id = ANY($1::bigint[])
    `, [ids]);
    return result.rows;
  }
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT id, folio_dia, fecha_folio FROM ${table}
    WHERE id IN (${placeholders})
  `).all(...ids);
}

async function decorate(payload) {
  const orders = [];
  collect(payload, orders, new Set());
  if (!orders.length) return payload;

  const activeIds = [...new Set(orders.filter(x => !x.archivado).map(x => Number(x.id)))];
  const archivedIds = [...new Set(orders.filter(x => x.archivado).map(x => Number(x.id)))];
  const [activeRows, archivedRows, fallbackRows] = await Promise.all([
    rows('pedidos', activeIds),
    rows('pedidos_archivados', archivedIds),
    rows('pedidos_archivados', activeIds)
  ]);
  const activeMap = new Map(activeRows.map(row => [Number(row.id), row]));
  const archivedMap = new Map([...archivedRows, ...fallbackRows]
    .map(row => [Number(row.id), row]));

  for (const order of orders) {
    const id = Number(order.id);
    const row = order.archivado
      ? archivedMap.get(id)
      : activeMap.get(id) || archivedMap.get(id);
    const folio = Number(row?.folio_dia || 0);
    if (!folio) continue;
    order.folio = folio;
    order.numeroPedido = folio;
    order.fechaFolio = row.fecha_folio || null;
  }
  return payload;
}

async function dailyOrderFolioMiddleware(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  try {
    await ready();
  } catch (error) {
    console.error('Error inicializando folios diarios:', error);
    return res.status(503).json({
      ok: false,
      message: 'Los folios diarios no están disponibles'
    });
  }

  const originalJson = res.json.bind(res);
  res.json = function jsonWithFolio(payload) {
    decorate(payload).then(originalJson).catch(error => {
      console.error('No se pudo agregar el folio diario:', error);
      originalJson(payload);
    });
    return res;
  };
  return next();
}

module.exports = { dailyOrderFolioMiddleware, ready };
