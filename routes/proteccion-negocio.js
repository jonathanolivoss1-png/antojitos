// KITCHEN_PRODUCT_CHANGE_MARKERS_V1
// BUSINESS_PROTECTION_V1
'use strict';

const express = require('express');
const crypto = require('crypto');
const pgPool = require('../postgres');
const sqliteDb = require('../database/db');
const { requireAuth } = require('../middleware/auth');
const { broadcastAdminEvent } = require('../realtime/events');

const router = express.Router();
const ALLOWED_STATES = new Set(['Confirmado', 'Entregado', 'Cancelado']);
const BACKUP_FORMAT = 'antojitos-complete-backup';
const BACKUP_VERSION = 2;

const BACKUP_TABLES = [
  'configuracion',
  'usuarios',
  'meseros_usuarios',
  'pedidos',
  'pedidos_archivados',
  'calculadora_calculos',
  'calculadora_productos',
  'pedidos_correcciones',
  'pedidos_cocina_estado',
  'cocina_usuarios',
  'pedidos_preparacion',
];
const OPTIONAL_BACKUP_TABLES = new Set([
  'pedidos_cocina_estado',
  'cocina_usuarios',
  'pedidos_preparacion',
]);

const DELETE_ORDER = [
  'pedidos_cocina_estado',
  'pedidos_correcciones',
  'calculadora_productos',
  'calculadora_calculos',
  'pedidos_archivados',
  'pedidos',
  'meseros_usuarios',
  'configuracion',
  'usuarios',
  'pedidos_preparacion',
  'cocina_usuarios',
];

const INSERT_ORDER = [
  'configuracion',
  'usuarios',
  'meseros_usuarios',
  'pedidos',
  'pedidos_archivados',
  'calculadora_calculos',
  'calculadora_productos',
  'pedidos_correcciones',
  'pedidos_cocina_estado',
  'cocina_usuarios',
  'pedidos_preparacion',
];

function sanitizeText(value, maxLength = 240) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundMoney(value) {
  return Math.round(sanitizeNumber(value) * 100) / 100;
}

function quoteIdentifier(identifier) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error('Identificador SQL inválido');
  }
  return `"${identifier}"`;
}

function parseJsonArray(value) {
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
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? new Date().toISOString()
    : date.toISOString();
}

function mapOrder(row) {
  return {
    id: Number(row.id),
    clienteToken: row.cliente_token || '',
    cliente: String(row.cliente || ''),
    telefono: String(row.telefono || ''),
    direccion: String(row.direccion || ''),
    tipoEntrega: String(row.tipo_entrega || ''),
    productos: parseJsonArray(row.productos),
    subtotal: Number(row.subtotal || 0),
    envio: Number(row.envio || 0),
    total: Number(row.total || 0),
    estado: String(row.estado || 'Confirmado'),
    fecha: normalizeDate(row.fecha)
  };
}

function mapCalculation(row, products = []) {
  return {
    id: Number(row.id),
    fecha: normalizeDate(row.fecha),
    origen: String(row.origen || 'manual'),
    cantidadDisponible: Number(row.cantidad_disponible || 0),
    tipoCantidad: String(row.tipo_cantidad || 'bruta'),
    cantidadProductos: Number(row.cantidad_productos || 0),
    costoTotal: Number(row.costo_total || 0),
    ventaTotal: Number(row.venta_total || 0),
    gananciaEstimada: Number(row.ganancia_estimada || 0),
    margenGanancia: Number(row.margen_ganancia || 0),
    saldoRestante: Number(row.saldo_restante || 0),
    productos: products.map(item => ({
      id: Number(item.id),
      nombre: String(item.nombre || ''),
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

function normalizeCalculatorProducts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 500)
    .map(item => {
      const name = sanitizeText(item?.name || item?.nombre || '', 120);
      const qty = Math.max(0, sanitizeNumber(item?.qty ?? item?.cantidad));
      const costUnit = Math.max(
        0,
        sanitizeNumber(item?.costUnit ?? item?.costoUnitario)
      );
      const rawPrice =
        item?.priceUnit ??
        item?.precioVentaUnitario ??
        '';
      const hasSalePrice =
        String(rawPrice).trim() !== '' &&
        Number.isFinite(Number(rawPrice)) &&
        Number(rawPrice) >= 0;
      const priceUnit = hasSalePrice
        ? Math.max(0, Number(rawPrice))
        : 0;
      if (!name || qty <= 0) return null;

      const costTotal = roundMoney(qty * costUnit);
      const saleTotal = roundMoney(qty * priceUnit);
      const gain = roundMoney(saleTotal - costTotal);
      const margin = saleTotal > 0
        ? roundMoney((gain / saleTotal) * 100)
        : 0;

      return {
        name,
        qty,
        costUnit: roundMoney(costUnit),
        priceUnit: roundMoney(priceUnit),
        costTotal,
        saleTotal,
        gananciaEstimada: gain,
        margenGanancia: margin
      };
    })
    .filter(Boolean);
}

function normalizeCalculatorPayload(body) {
  const productos = normalizeCalculatorProducts(body?.productos || []);
  const costoTotal = roundMoney(
    productos.reduce((sum, item) => sum + item.costTotal, 0)
  );
  const ventaTotal = roundMoney(
    productos.reduce((sum, item) => sum + item.saleTotal, 0)
  );
  const gananciaEstimada = roundMoney(ventaTotal - costoTotal);
  const margenGanancia = ventaTotal > 0
    ? roundMoney((gananciaEstimada / ventaTotal) * 100)
    : 0;

  const requestedOrigin = sanitizeText(body?.origen || 'manual', 40);
  const origen = [
    'manual',
    'dashboard',
    'sin_cantidad_inicial'
  ].includes(requestedOrigin)
    ? requestedOrigin
    : 'manual';

  const requestedType = sanitizeText(body?.tipoCantidad || 'bruta', 20);
  const tipoCantidad = ['bruta', 'neta'].includes(requestedType)
    ? requestedType
    : 'bruta';

  const cantidadDisponible = roundMoney(
    Math.max(0, sanitizeNumber(body?.cantidadDisponible))
  );

  const saldoRestante = origen === 'sin_cantidad_inicial'
    ? 0
    : tipoCantidad === 'neta'
      ? cantidadDisponible
      : roundMoney(cantidadDisponible - costoTotal);

  return {
    origen,
    cantidadDisponible,
    tipoCantidad,
    cantidadProductos: productos.length,
    costoTotal,
    ventaTotal,
    gananciaEstimada,
    margenGanancia,
    saldoRestante,
    productos
  };
}

function normalizeCorrectedProducts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 100)
    .map(item => {
      const name = sanitizeText(item?.name || item?.nombre || '', 180);
      const qty = Math.min(
        999,
        Math.max(1, Math.floor(sanitizeNumber(item?.qty ?? item?.cantidad, 1)))
      );
      const price = roundMoney(
        Math.max(0, sanitizeNumber(item?.price ?? item?.precio))
      );
      const choice = sanitizeText(
        item?.choice
          || item?.opcion
          || item?.notes
          || item?.note
          || item?.observaciones
          || '',
        240
      );
      const productId = sanitizeText(item?.productId || '', 100);
      const optionId = sanitizeText(item?.optionId || '', 100);
      if (!name) return null;

      return {
        qty,
        name,
        price,
        ...(productId ? { productId } : {}),
        ...(optionId ? { optionId } : {}),
        ...(choice ? { choice } : {})
      };
    })
    .filter(Boolean);
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

function changedFields(before, after) {
  return Object.keys(after).filter(
    key => JSON.stringify(before[key]) !== JSON.stringify(after[key])
  );
}

function stableBackupPayload(backup) {
  return JSON.stringify({
    format: backup.format,
    version: backup.version,
    generatedAt: backup.generatedAt,
    data: backup.data
  });
}

function calculateBackupIntegrity(backup) {
  return crypto
    .createHash('sha256')
    .update(stableBackupPayload(backup))
    .digest('hex');
}

async function tableExists(queryable, tableName) {
  const result = await queryable.query(
    'SELECT to_regclass($1) AS table_name',
    [`public.${tableName}`]
  );
  return Boolean(result.rows[0]?.table_name);
}

async function tableColumns(queryable, tableName) {
  const result = await queryable.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
    `,
    [tableName]
  );
  return result.rows.map(row => row.column_name);
}

async function ensureTables() {
  if (!pgPool) return;

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS calculadora_calculos (
      id BIGSERIAL PRIMARY KEY,
      fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      origen TEXT NOT NULL DEFAULT 'manual',
      cantidad_disponible NUMERIC(14, 2) NOT NULL DEFAULT 0,
      tipo_cantidad TEXT NOT NULL DEFAULT 'bruta',
      cantidad_productos INTEGER NOT NULL DEFAULT 0,
      costo_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
      venta_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
      ganancia_estimada NUMERIC(14, 2) NOT NULL DEFAULT 0,
      margen_ganancia NUMERIC(14, 2) NOT NULL DEFAULT 0,
      saldo_restante NUMERIC(14, 2) NOT NULL DEFAULT 0,
      legacy_sqlite_id BIGINT UNIQUE
    );

    ALTER TABLE calculadora_calculos
      ADD COLUMN IF NOT EXISTS legacy_sqlite_id BIGINT;

    CREATE UNIQUE INDEX IF NOT EXISTS
      idx_calculadora_calculos_legacy_sqlite
      ON calculadora_calculos (legacy_sqlite_id)
      WHERE legacy_sqlite_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS calculadora_productos (
      id BIGSERIAL PRIMARY KEY,
      calculo_id BIGINT NOT NULL
        REFERENCES calculadora_calculos(id)
        ON DELETE CASCADE,
      nombre TEXT NOT NULL,
      cantidad NUMERIC(14, 3) NOT NULL DEFAULT 0,
      costo_unitario NUMERIC(14, 2) NOT NULL DEFAULT 0,
      precio_venta_unitario NUMERIC(14, 2) NOT NULL DEFAULT 0,
      costo_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
      venta_total NUMERIC(14, 2) NOT NULL DEFAULT 0,
      ganancia_estimada NUMERIC(14, 2) NOT NULL DEFAULT 0,
      margen_ganancia NUMERIC(14, 2) NOT NULL DEFAULT 0,
      legacy_sqlite_id BIGINT
    );

    ALTER TABLE calculadora_productos
      ADD COLUMN IF NOT EXISTS legacy_sqlite_id BIGINT;

    CREATE INDEX IF NOT EXISTS
      idx_calculadora_productos_calculo
      ON calculadora_productos (calculo_id);

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

    CREATE INDEX IF NOT EXISTS
      idx_pedidos_correcciones_pedido
      ON pedidos_correcciones (pedido_id, fecha DESC);

    CREATE TABLE IF NOT EXISTS respaldos_restauracion (
      id BIGSERIAL PRIMARY KEY,
      fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      motivo TEXT NOT NULL,
      resumen JSONB NOT NULL DEFAULT '{}'::jsonb,
      respaldo JSONB NOT NULL
    );
  `);

  /*
   * El historial no usa una llave foránea hacia pedidos:
   * cuando un pedido se archiva, su auditoría debe conservarse.
   * También evita una carrera durante el arranque, porque la tabla
   * pedidos se inicializa desde otro módulo.
   */
  const constraints = await pgPool.query(`
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'pedidos_correcciones'::regclass
      AND contype = 'f'
  `);

  for (const row of constraints.rows) {
    await pgPool.query(
      `ALTER TABLE pedidos_correcciones
       DROP CONSTRAINT ${quoteIdentifier(row.conname)}`
    );
  }
}

async function migrateSqliteCalculator() {
  if (!pgPool) {
    return {
      attempted: false,
      migratedCalculations: 0,
      migratedProducts: 0
    };
  }

  let calculationTable;
  let productTable;

  try {
    calculationTable = sqliteDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='calculadora_calculos'"
      )
      .get();
    productTable = sqliteDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='calculadora_productos'"
      )
      .get();
  } catch {
    return {
      attempted: false,
      migratedCalculations: 0,
      migratedProducts: 0
    };
  }

  if (!calculationTable || !productTable) {
    return {
      attempted: false,
      migratedCalculations: 0,
      migratedProducts: 0
    };
  }

  const calculations = sqliteDb
    .prepare('SELECT * FROM calculadora_calculos ORDER BY id')
    .all();

  const client = await pgPool.connect();
  let migratedCalculations = 0;
  let migratedProducts = 0;

  try {
    await client.query('BEGIN');

    for (const calculation of calculations) {
      const inserted = await client.query(
        `
          INSERT INTO calculadora_calculos (
            fecha,
            origen,
            cantidad_disponible,
            tipo_cantidad,
            cantidad_productos,
            costo_total,
            venta_total,
            ganancia_estimada,
            margen_ganancia,
            saldo_restante,
            legacy_sqlite_id
          )
          VALUES (
            $1::timestamptz,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11
          )
          ON CONFLICT (legacy_sqlite_id)
          DO NOTHING
          RETURNING id
        `,
        [
          normalizeDate(calculation.fecha),
          calculation.origen || 'manual',
          calculation.cantidad_disponible || 0,
          calculation.tipo_cantidad || 'bruta',
          calculation.cantidad_productos || 0,
          calculation.costo_total || 0,
          calculation.venta_total || 0,
          calculation.ganancia_estimada || 0,
          calculation.margen_ganancia || 0,
          calculation.saldo_restante || 0,
          calculation.id
        ]
      );

      if (!inserted.rows[0]) continue;

      migratedCalculations += 1;
      const postgresCalculationId = inserted.rows[0].id;
      const products = sqliteDb
        .prepare(
          'SELECT * FROM calculadora_productos WHERE calculo_id = ? ORDER BY id'
        )
        .all(calculation.id);

      for (const product of products) {
        await client.query(
          `
            INSERT INTO calculadora_productos (
              calculo_id,
              nombre,
              cantidad,
              costo_unitario,
              precio_venta_unitario,
              costo_total,
              venta_total,
              ganancia_estimada,
              margen_ganancia,
              legacy_sqlite_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `,
          [
            postgresCalculationId,
            product.nombre,
            product.cantidad || 0,
            product.costo_unitario || 0,
            product.precio_venta_unitario || 0,
            product.costo_total || 0,
            product.venta_total || 0,
            product.ganancia_estimada || 0,
            product.margen_ganancia || 0,
            product.id
          ]
        );
        migratedProducts += 1;
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  return {
    attempted: true,
    migratedCalculations,
    migratedProducts
  };
}

let migrationStatus = {
  attempted: false,
  migratedCalculations: 0,
  migratedProducts: 0,
  error: null
};

let readyPromise = null;

async function initializeProtection() {
  if (!pgPool) return;

  await ensureTables();

  try {
    migrationStatus = await migrateSqliteCalculator();
  } catch (error) {
    migrationStatus = {
      attempted: true,
      migratedCalculations: 0,
      migratedProducts: 0,
      error: error.message
    };
    console.error(
      'No se pudo migrar el historial SQLite de calculadora:',
      error
    );
  }
}

async function waitReady() {
  if (!pgPool) return;

  if (!readyPromise) {
    readyPromise = initializeProtection().catch(error => {
      readyPromise = null;
      throw error;
    });
  }

  await readyPromise;
}

/*
 * Inicia la preparación sin bloquear la carga del servidor.
 * Si PostgreSQL todavía está arrancando, el primer endpoint volverá
 * a intentarlo mediante waitReady().
 */
void waitReady().catch(error => {
  console.error(
    'No se pudo preparar inicialmente la protección del negocio:',
    error
  );
});

async function loadCalculation(id, queryable = pgPool) {
  const calculationResult = await queryable.query(
    'SELECT * FROM calculadora_calculos WHERE id = $1 LIMIT 1',
    [id]
  );
  const calculation = calculationResult.rows[0];
  if (!calculation) return null;

  const productsResult = await queryable.query(
    `
      SELECT *
      FROM calculadora_productos
      WHERE calculo_id = $1
      ORDER BY id
    `,
    [id]
  );

  return mapCalculation(calculation, productsResult.rows);
}

async function insertCalculationProducts(client, calculationId, products) {
  for (const product of products) {
    await client.query(
      `
        INSERT INTO calculadora_productos (
          calculo_id,
          nombre,
          cantidad,
          costo_unitario,
          precio_venta_unitario,
          costo_total,
          venta_total,
          ganancia_estimada,
          margen_ganancia
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        calculationId,
        product.name,
        product.qty,
        product.costUnit,
        product.priceUnit,
        product.costTotal,
        product.saleTotal,
        product.gananciaEstimada,
        product.margenGanancia
      ]
    );
  }
}

router.get('/proteccion/resumen', requireAuth, async (req, res) => {
  try {
    if (!pgPool) {
      return res.status(503).json({
        ok: false,
        message: 'PostgreSQL no está disponible'
      });
    }
    await waitReady();

    const counts = {};
    for (const table of BACKUP_TABLES) {
      if (!(await tableExists(pgPool, table))) {
        counts[table] = 0;
        continue;
      }
      const result = await pgPool.query(
        `SELECT COUNT(*)::int AS total FROM ${quoteIdentifier(table)}`
      );
      counts[table] = Number(result.rows[0]?.total || 0);
    }

    return res.json({
      ok: true,
      database: 'PostgreSQL',
      calculator: {
        calculations: counts.calculadora_calculos || 0,
        products: counts.calculadora_productos || 0,
        migration: migrationStatus
      },
      corrections: counts.pedidos_correcciones || 0,
      counts
    });
  } catch (error) {
    console.error('Error consultando protección del negocio:', error);
    return res.status(500).json({
      ok: false,
      message: 'No se pudo consultar el estado de protección'
    });
  }
});

router.post('/calculadora', requireAuth, async (req, res, next) => {
  if (!pgPool) return next();

  const client = await pgPool.connect();
  try {
    await waitReady();
    const payload = normalizeCalculatorPayload(req.body || {});
    await client.query('BEGIN');

    const inserted = await client.query(
      `
        INSERT INTO calculadora_calculos (
          fecha,
          origen,
          cantidad_disponible,
          tipo_cantidad,
          cantidad_productos,
          costo_total,
          venta_total,
          ganancia_estimada,
          margen_ganancia,
          saldo_restante
        )
        VALUES (
          NOW(),
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9
        )
        RETURNING id
      `,
      [
        payload.origen,
        payload.cantidadDisponible,
        payload.tipoCantidad,
        payload.cantidadProductos,
        payload.costoTotal,
        payload.ventaTotal,
        payload.gananciaEstimada,
        payload.margenGanancia,
        payload.saldoRestante
      ]
    );

    const id = inserted.rows[0].id;
    await insertCalculationProducts(client, id, payload.productos);
    await client.query('COMMIT');

    return res.status(201).json({
      ok: true,
      calculo: await loadCalculation(id)
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error guardando cálculo en PostgreSQL:', error);
    return res.status(500).json({
      ok: false,
      message: 'No se pudo guardar el cálculo'
    });
  } finally {
    client.release();
  }
});

router.get('/calculadora', requireAuth, async (req, res, next) => {
  if (!pgPool) return next();

  try {
    await waitReady();
    const calculationsResult = await pgPool.query(
      'SELECT * FROM calculadora_calculos ORDER BY fecha DESC, id DESC'
    );
    const productsResult = await pgPool.query(
      'SELECT * FROM calculadora_productos ORDER BY calculo_id, id'
    );

    const groupedProducts = new Map();
    for (const product of productsResult.rows) {
      const key = String(product.calculo_id);
      if (!groupedProducts.has(key)) groupedProducts.set(key, []);
      groupedProducts.get(key).push(product);
    }

    return res.json({
      ok: true,
      calculos: calculationsResult.rows.map(row =>
        mapCalculation(row, groupedProducts.get(String(row.id)) || [])
      ),
      almacenamiento: 'PostgreSQL'
    });
  } catch (error) {
    console.error('Error cargando cálculos PostgreSQL:', error);
    return res.status(500).json({
      ok: false,
      message: 'No se pudieron cargar los cálculos'
    });
  }
});

router.get('/calculadora/:id', requireAuth, async (req, res, next) => {
  if (!pgPool) return next();
  if (req.params.id === 'draft') return next();

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return next();

  try {
    await waitReady();
    const calculation = await loadCalculation(id);
    if (!calculation) {
      return res.status(404).json({
        ok: false,
        message: 'Cálculo no encontrado'
      });
    }
    return res.json({
      ok: true,
      calculo: calculation,
      almacenamiento: 'PostgreSQL'
    });
  } catch (error) {
    console.error('Error consultando cálculo PostgreSQL:', error);
    return res.status(500).json({
      ok: false,
      message: 'No se pudo consultar el cálculo'
    });
  }
});

router.put('/calculadora/:id', requireAuth, async (req, res, next) => {
  if (!pgPool) return next();
  if (req.params.id === 'draft') return next();

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return next();

  const client = await pgPool.connect();
  try {
    await waitReady();
    const payload = normalizeCalculatorPayload(req.body || {});
    await client.query('BEGIN');

    const updated = await client.query(
      `
        UPDATE calculadora_calculos
        SET
          origen = $1,
          cantidad_disponible = $2,
          tipo_cantidad = $3,
          cantidad_productos = $4,
          costo_total = $5,
          venta_total = $6,
          ganancia_estimada = $7,
          margen_ganancia = $8,
          saldo_restante = $9
        WHERE id = $10
        RETURNING id
      `,
      [
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
      ]
    );

    if (!updated.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        ok: false,
        message: 'Cálculo no encontrado'
      });
    }

    await client.query(
      'DELETE FROM calculadora_productos WHERE calculo_id = $1',
      [id]
    );
    await insertCalculationProducts(client, id, payload.productos);
    await client.query('COMMIT');

    return res.json({
      ok: true,
      calculo: await loadCalculation(id)
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error actualizando cálculo PostgreSQL:', error);
    return res.status(500).json({
      ok: false,
      message: 'No se pudo actualizar el cálculo'
    });
  } finally {
    client.release();
  }
});

router.delete('/calculadora/:id', requireAuth, async (req, res, next) => {
  if (!pgPool) return next();
  if (req.params.id === 'draft') return next();

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return next();

  try {
    await waitReady();
    const result = await pgPool.query(
      'DELETE FROM calculadora_calculos WHERE id = $1 RETURNING id',
      [id]
    );
    if (!result.rows[0]) {
      return res.status(404).json({
        ok: false,
        message: 'Cálculo no encontrado'
      });
    }
    return res.json({
      ok: true,
      deletedId: id
    });
  } catch (error) {
    console.error('Error eliminando cálculo PostgreSQL:', error);
    return res.status(500).json({
      ok: false,
      message: 'No se pudo eliminar el cálculo'
    });
  }
});

async function createBackup(queryable = pgPool) {
  const data = {};
  const counts = {};

  for (const tableName of BACKUP_TABLES) {
    if (!(await tableExists(queryable, tableName))) {
      data[tableName] = [];
      counts[tableName] = 0;
      continue;
    }
    const result = await queryable.query(
      `SELECT * FROM ${quoteIdentifier(tableName)}`
    );
    data[tableName] = result.rows;
    counts[tableName] = result.rows.length;
  }

  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      application: 'Antojitos Los Anafres',
      database: 'PostgreSQL'
    },
    counts,
    data
  };

  backup.integrity = {
    algorithm: 'sha256',
    digest: calculateBackupIntegrity(backup)
  };

  return backup;
}

function validateBackup(backup) {
  if (!backup || typeof backup !== 'object') {
    throw new Error('El archivo no contiene un respaldo válido');
  }
  if (backup.format !== BACKUP_FORMAT) {
    throw new Error('El formato del respaldo no es compatible');
  }
  if (Number(backup.version) !== BACKUP_VERSION) {
    throw new Error('La versión del respaldo no es compatible');
  }
  if (!backup.data || typeof backup.data !== 'object') {
    throw new Error('El respaldo no contiene datos');
  }

  const optionalMissingTables = [];

  for (const tableName of BACKUP_TABLES) {
    if (!Array.isArray(backup.data[tableName])) {
      if (OPTIONAL_BACKUP_TABLES.has(tableName)) {
        optionalMissingTables.push(tableName);
        continue;
      }

      throw new Error(`Falta la tabla ${tableName} en el respaldo`);
    }
  }

  const expected = calculateBackupIntegrity(backup);
  if (
    backup.integrity?.algorithm !== 'sha256' ||
    backup.integrity?.digest !== expected
  ) {
    throw new Error(
      'La verificación de integridad falló; el archivo pudo modificarse o dañarse'
    );
  }

  for (const tableName of optionalMissingTables) {
    backup.data[tableName] = [];
  }

  return {
    generatedAt: backup.generatedAt,
    counts: Object.fromEntries(
      BACKUP_TABLES.map(table => [
        table,
        backup.data[table].length
      ])
    )
  };
}

async function insertRows(queryable, tableName, rows, targetTable = null) {
  if (!rows.length) return 0;

  const destination = targetTable || tableName;
  const availableColumns = await tableColumns(queryable, tableName);
  const available = new Set(availableColumns);
  let inserted = 0;

  for (const row of rows) {
    const columns = Object.keys(row).filter(column => available.has(column));
    if (!columns.length) continue;

    const placeholders = columns.map((_, index) => `$${index + 1}`);
    const values = columns.map(column => row[column]);

    await queryable.query(
      `
        INSERT INTO ${quoteIdentifier(destination)}
          (${columns.map(quoteIdentifier).join(', ')})
        VALUES (${placeholders.join(', ')})
      `,
      values
    );
    inserted += 1;
  }

  return inserted;
}

async function resetSequence(queryable, tableName) {
  const columns = await tableColumns(queryable, tableName);
  if (!columns.includes('id')) return;

  await queryable.query(
    `
      SELECT setval(
        pg_get_serial_sequence($1, 'id'),
        COALESCE((SELECT MAX(id) FROM ${quoteIdentifier(tableName)}), 1),
        (SELECT COUNT(*) > 0 FROM ${quoteIdentifier(tableName)})
      )
    `,
    [tableName]
  ).catch(() => {});
}

async function testBackupRestore(backup) {
  validateBackup(backup);

  if (!pgPool) {
    throw new Error('PostgreSQL no está disponible');
  }

  await waitReady();

  const client = await pgPool.connect();
  const resultCounts = {};

  try {
    await client.query('BEGIN');

    for (const tableName of INSERT_ORDER) {
      const rows = backup.data[tableName];
      const exists = await tableExists(client, tableName);

      if (!exists) {
        if (rows.length) {
          throw new Error(
            `El respaldo contiene ${rows.length} registros de ${tableName}, `
            + 'pero esa tabla no existe en PostgreSQL'
          );
        }

        resultCounts[tableName] = 0;
        continue;
      }

      const tempName = `tmp_restore_${tableName}`;
      await client.query(
        `
          CREATE TEMP TABLE ${quoteIdentifier(tempName)}
          AS SELECT * FROM ${quoteIdentifier(tableName)} WITH NO DATA
        `
      );

      resultCounts[tableName] = await insertRows(
        client,
        tableName,
        rows,
        tempName
      );

      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total FROM ${quoteIdentifier(tempName)}`
      );
      const actual = Number(countResult.rows[0]?.total || 0);
      const expected = rows.length;

      if (actual !== expected) {
        throw new Error(
          `La prueba de ${tableName} esperaba ${expected} registros y obtuvo ${actual}`
        );
      }
    }

    await client.query('ROLLBACK');
    return resultCounts;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function saveAutomaticSnapshot(reason) {
  const backup = await createBackup(pgPool);
  const result = await pgPool.query(
    `
      INSERT INTO respaldos_restauracion (
        motivo,
        resumen,
        respaldo
      )
      VALUES ($1, $2::jsonb, $3::jsonb)
      RETURNING id, fecha
    `,
    [
      reason,
      JSON.stringify(backup.counts),
      JSON.stringify(backup)
    ]
  );
  await pgPool.query(`
    DELETE FROM respaldos_restauracion
    WHERE id NOT IN (
      SELECT id
      FROM respaldos_restauracion
      ORDER BY fecha DESC, id DESC
      LIMIT 10
    )
  `);

  return {
    id: Number(result.rows[0].id),
    fecha: result.rows[0].fecha,
    backup
  };
}

async function restoreBackup(backup, reason) {
  if (!pgPool) {
    throw new Error('PostgreSQL no está disponible');
  }

  await waitReady();

  const summary = validateBackup(backup);
  await testBackupRestore(backup);

  const snapshot = await saveAutomaticSnapshot(
    `Antes de restaurar: ${sanitizeText(reason, 180)}`
  );

  const client = await pgPool.connect();
  const restoredCounts = {};

  try {
    await client.query('BEGIN');

    for (const tableName of DELETE_ORDER) {
      if (await tableExists(client, tableName)) {
        await client.query(
          `DELETE FROM ${quoteIdentifier(tableName)}`
        );
      }
    }

    for (const tableName of INSERT_ORDER) {
      const rows = backup.data[tableName];
      const exists = await tableExists(client, tableName);

      if (!exists) {
        if (rows.length) {
          throw new Error(
            `No se puede restaurar ${tableName}: la tabla no existe`
          );
        }

        restoredCounts[tableName] = 0;
        continue;
      }

      restoredCounts[tableName] = await insertRows(
        client,
        tableName,
        rows
      );
      await resetSequence(client, tableName);
    }

    for (const tableName of INSERT_ORDER) {
      const rows = backup.data[tableName];

      if (!(await tableExists(client, tableName))) {
        if (rows.length) {
          throw new Error(
            `No se pudo comprobar ${tableName}: la tabla no existe`
          );
        }
        continue;
      }

      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total FROM ${quoteIdentifier(tableName)}`
      );
      const actual = Number(countResult.rows[0]?.total || 0);
      const expected = rows.length;

      if (actual !== expected) {
        throw new Error(
          `La restauración de ${tableName} esperaba ${expected} registros y obtuvo ${actual}`
        );
      }
    }

    await client.query('COMMIT');

    broadcastAdminEvent('orders-updated', {
      ts: Date.now(),
      reason: 'full-backup-restored'
    });
    broadcastAdminEvent('settings-updated', {
      ts: Date.now(),
      reason: 'full-backup-restored'
    });

    return {
      generatedAt: summary.generatedAt,
      restoredCounts,
      automaticSnapshot: {
        id: snapshot.id,
        fecha: normalizeDate(snapshot.fecha)
      }
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

router.get('/proteccion/respaldo', requireAuth, async (req, res) => {
  try {
    if (!pgPool) {
      return res.status(503).json({
        ok: false,
        message: 'PostgreSQL no está disponible'
      });
    }
    await waitReady();
    const backup = await createBackup();

    const date = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="respaldo-antojitos-${date}.json"`
    );
    return res.send(JSON.stringify(backup, null, 2));
  } catch (error) {
    console.error('Error generando respaldo completo:', error);
    return res.status(500).json({
      ok: false,
      message: 'No se pudo generar el respaldo'
    });
  }
});

router.post(
  '/proteccion/probar-restauracion',
  requireAuth,
  async (req, res) => {
    try {
      if (!pgPool) {
        return res.status(503).json({
          ok: false,
          message: 'PostgreSQL no está disponible'
        });
      }
      await waitReady();
      const backup = req.body?.backup;
      const summary = validateBackup(backup);
      const testedCounts = await testBackupRestore(backup);

      return res.json({
        ok: true,
        message:
          'La restauración de prueba terminó correctamente sin modificar producción',
        summary,
        testedCounts
      });
    } catch (error) {
      console.error('Prueba de restauración fallida:', error);
      return res.status(400).json({
        ok: false,
        message: error.message || 'La prueba de restauración falló'
      });
    }
  }
);

router.post('/proteccion/restaurar', requireAuth, async (req, res) => {
  try {
    if (!pgPool) {
      return res.status(503).json({
        ok: false,
        message: 'PostgreSQL no está disponible'
      });
    }
    if (req.body?.confirmation !== 'RESTAURAR') {
      return res.status(400).json({
        ok: false,
        message: 'Escribe RESTAURAR para confirmar'
      });
    }

    await waitReady();
    const result = await restoreBackup(
      req.body?.backup,
      req.body?.reason || 'Restauración manual'
    );

    return res.json({
      ok: true,
      message: 'Respaldo restaurado y verificado correctamente',
      ...result
    });
  } catch (error) {
    console.error('Error restaurando respaldo:', error);
    return res.status(400).json({
      ok: false,
      message: error.message || 'No se pudo restaurar el respaldo'
    });
  }
});

router.get('/proteccion/copias-automaticas', requireAuth, async (req, res) => {
  try {
    if (!pgPool) {
      return res.status(503).json({
        ok: false,
        message: 'PostgreSQL no está disponible'
      });
    }
    await waitReady();
    const result = await pgPool.query(
      `
        SELECT id, fecha, motivo, resumen
        FROM respaldos_restauracion
        ORDER BY fecha DESC, id DESC
        LIMIT 10
      `
    );
    return res.json({
      ok: true,
      copies: result.rows.map(row => ({
        id: Number(row.id),
        fecha: normalizeDate(row.fecha),
        motivo: row.motivo,
        resumen: row.resumen
      }))
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: 'No se pudieron cargar las copias automáticas'
    });
  }
});

router.post(
  '/proteccion/copias-automaticas/:id/restaurar',
  requireAuth,
  async (req, res) => {
    try {
      if (!pgPool) {
        return res.status(503).json({
          ok: false,
          message: 'PostgreSQL no está disponible'
        });
      }

      await waitReady();

      if (req.body?.confirmation !== 'RESTAURAR') {
        return res.status(400).json({
          ok: false,
          message: 'Escribe RESTAURAR para confirmar'
        });
      }

      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          ok: false,
          message: 'Copia automática inválida'
        });
      }

      const result = await pgPool.query(
        `
          SELECT respaldo
          FROM respaldos_restauracion
          WHERE id = $1
          LIMIT 1
        `,
        [id]
      );
      const backup = result.rows[0]?.respaldo;
      if (!backup) {
        return res.status(404).json({
          ok: false,
          message: 'Copia automática no encontrada'
        });
      }

      const restored = await restoreBackup(
        backup,
        `Recuperación desde copia automática #${id}`
      );

      return res.json({
        ok: true,
        message: 'Copia automática restaurada correctamente',
        ...restored
      });
    } catch (error) {
      console.error('Error restaurando copia automática:', error);
      return res.status(400).json({
        ok: false,
        message: error.message || 'No se pudo restaurar la copia automática'
      });
    }
  }
);

router.get('/pedidos-corregibles', requireAuth, async (req, res) => {
  try {
    if (!pgPool) {
      return res.status(503).json({
        ok: false,
        message: 'PostgreSQL no está disponible'
      });
    }
    await waitReady();
    const result = await pgPool.query(
      `
        SELECT *
        FROM pedidos
        ORDER BY fecha DESC, id DESC
        LIMIT 300
      `
    );
    return res.json({
      ok: true,
      pedidos: result.rows.map(mapOrder)
    });
  } catch (error) {
    console.error('Error cargando pedidos corregibles:', error);
    return res.status(500).json({
      ok: false,
      message: 'No se pudieron cargar los pedidos'
    });
  }
});

router.get(
  '/pedidos/:id/historial-correcciones',
  requireAuth,
  async (req, res) => {
    try {
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

      await waitReady();
      const result = await pgPool.query(
        `
          SELECT
            id,
            pedido_id,
            fecha,
            usuario_id,
            usuario,
            motivo,
            campos_modificados,
            antes,
            despues
          FROM pedidos_correcciones
          WHERE pedido_id = $1
          ORDER BY fecha DESC, id DESC
        `,
        [id]
      );

      return res.json({
        ok: true,
        corrections: result.rows.map(row => ({
          id: Number(row.id),
          pedidoId: Number(row.pedido_id),
          fecha: normalizeDate(row.fecha),
          usuarioId: row.usuario_id ? Number(row.usuario_id) : null,
          usuario: row.usuario,
          motivo: row.motivo,
          camposModificados: row.campos_modificados,
          antes: row.antes,
          despues: row.despues
        }))
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        message: 'No se pudo cargar el historial de correcciones'
      });
    }
  }
);

router.put('/pedidos/:id/correccion', requireAuth, async (req, res) => {
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

  const reason = sanitizeText(req.body?.motivo || '', 300);
  if (reason.length < 5) {
    return res.status(400).json({
      ok: false,
      message: 'Escribe un motivo de al menos 5 caracteres'
    });
  }

  const products = normalizeCorrectedProducts(req.body?.productos);
  if (!products.length) {
    return res.status(400).json({
      ok: false,
      message: 'El pedido debe conservar al menos un producto'
    });
  }

  const cliente = sanitizeText(req.body?.cliente || '', 180);
  const telefono = sanitizeText(req.body?.telefono || '', 80);
  const direccion = sanitizeText(req.body?.direccion || '', 300);
  const tipoEntrega = sanitizeText(req.body?.tipoEntrega || '', 60);
  const estado = sanitizeText(req.body?.estado || '', 30);
  const envio = roundMoney(Math.max(0, sanitizeNumber(req.body?.envio)));

  if (!cliente || !tipoEntrega) {
    return res.status(400).json({
      ok: false,
      message: 'Cliente y tipo de entrega son obligatorios'
    });
  }
  if (!ALLOWED_STATES.has(estado)) {
    return res.status(400).json({
      ok: false,
      message: 'Estado inválido'
    });
  }

  const subtotal = roundMoney(
    products.reduce(
      (sum, item) => sum + item.qty * item.price,
      0
    )
  );
  const total = roundMoney(subtotal + envio);

  await waitReady();

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');

    const currentResult = await client.query(
      'SELECT * FROM pedidos WHERE id = $1 FOR UPDATE',
      [id]
    );
    const currentRow = currentResult.rows[0];

    if (!currentRow) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        ok: false,
        message: 'Pedido no encontrado o ya archivado'
      });
    }

    const before = comparableOrder(mapOrder(currentRow));
    const after = {
      cliente,
      telefono,
      direccion,
      tipoEntrega,
      productos: products,
      subtotal,
      envio,
      total,
      estado
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
          cliente = $1,
          telefono = $2,
          direccion = $3,
          tipo_entrega = $4,
          productos = $5::jsonb,
          subtotal = $6,
          envio = $7,
          total = $8,
          estado = $9
        WHERE id = $10
        RETURNING *
      `,
      [
        cliente,
        telefono,
        direccion,
        tipoEntrega,
        JSON.stringify(products),
        subtotal,
        envio,
        total,
        estado,
        id
      ]
    );

    const user = req.session?.user || {};
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
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)
        RETURNING id, fecha
      `,
      [
        id,
        user.id || null,
        sanitizeText(user.usuario || 'admin', 80) || 'admin',
        reason,
        JSON.stringify(fields),
        JSON.stringify(before),
        JSON.stringify(after)
      ]
    );

    await client.query('COMMIT');

    const updatedOrder = mapOrder(updatedResult.rows[0]);

    broadcastAdminEvent('orders-updated', {
      ts: Date.now(),
      reason: 'controlled-correction',
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
        motivo: reason,
        camposModificados: fields
      }
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error corrigiendo pedido:', error);
    return res.status(500).json({
      ok: false,
      message: 'No se pudo corregir el pedido'
    });
  } finally {
    client.release();
  }
});

module.exports = router;
