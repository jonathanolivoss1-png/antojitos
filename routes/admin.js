// REMOVE_LEGACY_BACKUP_AND_CASH_CLOSING_V1
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const pgPool = require('../postgres');
const usePostgres = Boolean(pgPool);
const { maybeArchiveAndResetDailyOrders } = require('./pedidos');
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
const CALCULATOR_HISTORY_KEY = 'calculator_history_v1';
const SOLD_PRODUCTS_SEPARATED_KEY = 'sold_products_separated_v1';

const CASH_CLOSINGS_KEY = 'cash_closings_v1';
const ADMIN_BACKUP_VERSION = 1;
const ADMIN_BACKUP_TABLES = [
  'configuracion',
  'pedidos',
  'pedidos_archivados',
  'calculadora_calculos',
  'calculadora_productos'
];
const MEXICO_CITY_TZ_OFFSET_MINUTES = 360;

function parseProductos(raw) {
  if (Array.isArray(raw)) {
    return raw;
  }

  if (!raw) {
    return [];
  }

  try {
    const parsed =
      typeof raw === 'string'
        ? JSON.parse(raw)
        : raw;

    return Array.isArray(parsed)
      ? parsed
      : [];
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


// === ADMIN_BUSINESS_TOOLS_BACKEND_V1 ===
function normalizeCashClosingRecord(value) {
  const source =
    value &&
    typeof value === 'object'
      ? value
      : {};

  return {
    expenses: roundMoney(
      Math.max(
        0,
        sanitizeNumber(
          source.expenses || 0
        )
      )
    ),

    countedCash: roundMoney(
      Math.max(
        0,
        sanitizeNumber(
          source.countedCash || 0
        )
      )
    ),

    notes: sanitizeText(
      source.notes || '',
      1200
    ),

    updatedAt:
      source.updatedAt
        ? new Date(
            source.updatedAt
          ).toISOString()
        : null
  };
}

async function readCashClosings() {
  const parsed =
    await readConfigJson(
      CASH_CLOSINGS_KEY
    );

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed)
  ) {
    return {};
  }

  return parsed;
}

async function getOrdersForCashClosing(dateKey) {
  const range =
    buildUtcRangeFromDateKey(
      dateKey,
      MEXICO_CITY_TZ_OFFSET_MINUTES
    );

  const [
    activeRows,
    archivedRows
  ] = await Promise.all([
    queryAll(
      `
        SELECT
          id,
          cliente,
          tipo_entrega,
          productos,
          subtotal,
          envio,
          total,
          estado,
          fecha
        FROM pedidos
        WHERE fecha >= ?
          AND fecha < ?
        ORDER BY fecha DESC, id DESC
      `,
      [
        range.startIso,
        range.endIso
      ]
    ),

    queryAll(
      `
        SELECT
          id,
          cliente,
          tipo_entrega,
          productos,
          subtotal,
          envio,
          total,
          estado,
          fecha
        FROM pedidos_archivados
        WHERE fecha = ?
        ORDER BY id DESC
      `,
      [dateKey]
    )
  ]);

  return [
    ...activeRows,
    ...archivedRows
  ];
}

function summarizeCashClosing(
  rows,
  closing
) {
  const productTotals =
    new Map();

  let grossSales = 0;
  let deliveredSales = 0;
  let shippingFees = 0;
  let validOrders = 0;
  let cancelledOrders = 0;
  let cancelledSales = 0;
  let deliveryOrders = 0;
  let pickupOrders = 0;

  rows.forEach(row => {
    const status =
      sanitizeText(
        row?.estado || '',
        60
      );

    const total =
      roundMoney(
        Number(
          row?.total || 0
        )
      );

    const isCancelled =
      status.toLowerCase() ===
      'cancelado';

    if (isCancelled) {
      cancelledOrders += 1;
      cancelledSales =
        roundMoney(
          cancelledSales +
          total
        );
      return;
    }

    validOrders += 1;
    grossSales =
      roundMoney(
        grossSales +
        total
      );

    shippingFees =
      roundMoney(
        shippingFees +
        Number(
          row?.envio || 0
        )
      );

    if (
      status.toLowerCase() ===
      'entregado'
    ) {
      deliveredSales =
        roundMoney(
          deliveredSales +
          total
        );
    }

    const delivery =
      sanitizeText(
        row?.tipo_entrega || '',
        80
      )
        .toLowerCase()
        .normalize('NFD')
        .replace(
          /[\u0300-\u036f]/g,
          ''
        );

    if (
      delivery.includes('domicilio') ||
      delivery.includes('envio')
    ) {
      deliveryOrders += 1;
    } else {
      pickupOrders += 1;
    }

    parseProductos(
      row?.productos
    ).forEach(item => {
      const name =
        sanitizeText(
          item?.name ||
          item?.nombre ||
          'Producto',
          140
        );

      const quantity =
        Math.max(
          0,
          Number(
            item?.qty ??
            item?.cantidad ??
            1
          )
        );

      if (
        !name ||
        quantity <= 0
      ) {
        return;
      }

      const key =
        name
          .toLowerCase()
          .normalize('NFD')
          .replace(
            /[\u0300-\u036f]/g,
            ''
          )
          .trim();

      const current =
        productTotals.get(key) || {
          name,
          quantity: 0
        };

      current.quantity +=
        quantity;

      productTotals.set(
        key,
        current
      );
    });
  });

  const topProduct =
    Array.from(
      productTotals.values()
    )
      .sort(
        (a, b) =>
          b.quantity -
          a.quantity
      )[0] ||
    null;

  const expenses =
    roundMoney(
      closing.expenses || 0
    );

  const countedCash =
    roundMoney(
      closing.countedCash || 0
    );

  const netAfterExpenses =
    roundMoney(
      grossSales -
      expenses
    );

  return {
    totalOrders:
      rows.length,

    validOrders,
    cancelledOrders,
    cancelledSales,

    grossSales,
    deliveredSales,

    pendingSales:
      roundMoney(
        grossSales -
        deliveredSales
      ),

    shippingFees,

    averageTicket:
      validOrders
        ? roundMoney(
            grossSales /
            validOrders
          )
        : 0,

    deliveryOrders,
    pickupOrders,

    topProduct:
      topProduct
        ? `${topProduct.name} (${topProduct.quantity})`
        : 'Sin datos',

    expenses,
    countedCash,
    netAfterExpenses,

    cashDifference:
      roundMoney(
        countedCash -
        grossSales
      )
  };
}

async function buildCashClosingResponse(dateKey) {
  const [
    rows,
    closings
  ] = await Promise.all([
    getOrdersForCashClosing(
      dateKey
    ),
    readCashClosings()
  ]);

  const closing =
    normalizeCashClosingRecord(
      closings[dateKey] || {}
    );

  return {
    ok: true,
    date: dateKey,
    timezone:
      'America/Mexico_City',
    closing,
    summary:
      summarizeCashClosing(
        rows,
        closing
      )
  };
}

function quoteAdminIdentifier(value) {
  const identifier =
    String(value || '');

  if (
    !/^[a-z_][a-z0-9_]*$/i.test(
      identifier
    )
  ) {
    throw new Error(
      'Identificador SQL inválido'
    );
  }

  return `"${identifier}"`;
}

async function postgresTableExists(
  client,
  tableName
) {
  const result =
    await client.query(
      `
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = $1
        LIMIT 1
      `,
      [tableName]
    );

  return Boolean(
    result.rows[0]
  );
}

async function postgresTableColumns(
  client,
  tableName
) {
  const result =
    await client.query(
      `
        SELECT
          column_name,
          data_type,
          udt_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
        ORDER BY ordinal_position
      `,
      [tableName]
    );

  return result.rows.map(row => ({
    name:
      row.column_name,
    type:
      row.data_type,
    udtName:
      row.udt_name
  }));
}

function sqliteTableExists(
  tableName
) {
  return Boolean(
    db.prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name = ?
        LIMIT 1
      `
    ).get(tableName)
  );
}

function sqliteTableColumns(
  tableName
) {
  return db
    .prepare(
      `PRAGMA table_info(${quoteAdminIdentifier(tableName)})`
    )
    .all()
    .map(row => ({
      name:
        row.name,
      type:
        row.type || ''
    }));
}

async function exportBackupTable(
  tableName
) {
  if (
    !ADMIN_BACKUP_TABLES.includes(
      tableName
    )
  ) {
    throw new Error(
      'Tabla no permitida en respaldo'
    );
  }

  const quoted =
    quoteAdminIdentifier(
      tableName
    );

  if (usePostgres) {
    if (
      !await postgresTableExists(
        pgPool,
        tableName
      )
    ) {
      return [];
    }

    const result =
      await pgPool.query(
        `SELECT * FROM ${quoted}`
      );

    return result.rows;
  }

  if (
    !sqliteTableExists(
      tableName
    )
  ) {
    return [];
  }

  return db
    .prepare(
      `SELECT * FROM ${quoted}`
    )
    .all();
}

async function createAdminBackupPayload() {
  const tables = {};

  for (
    const tableName
    of ADMIN_BACKUP_TABLES
  ) {
    tables[tableName] =
      await exportBackupTable(
        tableName
      );
  }

  return {
    format:
      'antojitos-admin-backup',

    version:
      ADMIN_BACKUP_VERSION,

    exportedAt:
      new Date().toISOString(),

    source:
      usePostgres
        ? 'postgresql'
        : 'sqlite',

    data: {
      tables
    }
  };
}

function normalizeBackupValue(
  value,
  column
) {
  if (
    value === undefined
  ) {
    return null;
  }

  if (
    value !== null &&
    typeof value === 'object'
  ) {
    return JSON.stringify(
      value
    );
  }

  return value;
}

async function restorePostgresTable(
  client,
  tableName,
  rows
) {
  if (
    !await postgresTableExists(
      client,
      tableName
    )
  ) {
    return 0;
  }

  const quoted =
    quoteAdminIdentifier(
      tableName
    );

  const columns =
    await postgresTableColumns(
      client,
      tableName
    );

  const columnMap =
    new Map(
      columns.map(column => [
        column.name,
        column
      ])
    );

  let restored = 0;

  for (const row of rows) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row)
    ) {
      continue;
    }

    const keys =
      Object.keys(row).filter(
        key =>
          columnMap.has(key)
      );

    if (!keys.length) {
      continue;
    }

    const values =
      keys.map(key =>
        normalizeBackupValue(
          row[key],
          columnMap.get(key)
        )
      );

    const placeholders =
      keys.map((key, index) => {
        const column =
          columnMap.get(key);

        const placeholder =
          `$${index + 1}`;

        if (
          column.type === 'jsonb' ||
          column.udtName === 'jsonb'
        ) {
          return `${placeholder}::jsonb`;
        }

        if (
          column.type === 'json' ||
          column.udtName === 'json'
        ) {
          return `${placeholder}::json`;
        }

        return placeholder;
      });

    await client.query(
      `
        INSERT INTO ${quoted} (
          ${keys.map(
            quoteAdminIdentifier
          ).join(', ')}
        )
        VALUES (
          ${placeholders.join(', ')}
        )
      `,
      values
    );

    restored += 1;
  }

  if (
    columnMap.has('id')
  ) {
    const sequenceResult =
      await client.query(
        `
          SELECT
            pg_get_serial_sequence(
              $1,
              'id'
            ) AS sequence_name
        `,
        [tableName]
      );

    const sequenceName =
      sequenceResult.rows[0]
        ?.sequence_name;

    if (sequenceName) {
      const maxResult =
        await client.query(
          `
            SELECT
              MAX(id) AS max_id,
              COUNT(*) AS row_count
            FROM ${quoted}
          `
        );

      const maxId =
        Number(
          maxResult.rows[0]
            ?.max_id ||
          1
        );

      const hasRows =
        Number(
          maxResult.rows[0]
            ?.row_count ||
          0
        ) > 0;

      await client.query(
        `
          SELECT setval(
            $1::regclass,
            $2,
            $3
          )
        `,
        [
          sequenceName,
          Math.max(1, maxId),
          hasRows
        ]
      );
    }
  }

  return restored;
}

function restoreSqliteTable(
  tableName,
  rows
) {
  if (
    !sqliteTableExists(
      tableName
    )
  ) {
    return 0;
  }

  const quoted =
    quoteAdminIdentifier(
      tableName
    );

  const columns =
    sqliteTableColumns(
      tableName
    );

  const allowed =
    new Set(
      columns.map(
        column =>
          column.name
      )
    );

  let restored = 0;

  for (const row of rows) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row)
    ) {
      continue;
    }

    const keys =
      Object.keys(row).filter(
        key =>
          allowed.has(key)
      );

    if (!keys.length) {
      continue;
    }

    const values =
      keys.map(key => {
        const value =
          row[key];

        if (
          value !== null &&
          typeof value === 'object'
        ) {
          return JSON.stringify(
            value
          );
        }

        return value;
      });

    db.prepare(
      `
        INSERT INTO ${quoted} (
          ${keys.map(
            quoteAdminIdentifier
          ).join(', ')}
        )
        VALUES (
          ${keys.map(() => '?').join(', ')}
        )
      `
    ).run(...values);

    restored += 1;
  }

  if (
    allowed.has('id')
  ) {
    const maxRow =
      db.prepare(
        `
          SELECT
            MAX(id) AS max_id
          FROM ${quoted}
        `
      ).get();

    const maxId =
      Number(
        maxRow?.max_id ||
        0
      );

    if (
      sqliteTableExists(
        'sqlite_sequence'
      )
    ) {
      db.prepare(
        `
          DELETE FROM sqlite_sequence
          WHERE name = ?
        `
      ).run(tableName);

      if (maxId > 0) {
        db.prepare(
          `
            INSERT INTO sqlite_sequence (
              name,
              seq
            )
            VALUES (?, ?)
          `
        ).run(
          tableName,
          maxId
        );
      }
    }
  }

  return restored;
}

function validateBackupPayload(
  backup
) {
  if (
    !backup ||
    backup.format !==
      'antojitos-admin-backup' ||
    !backup.data ||
    typeof backup.data !==
      'object' ||
    !backup.data.tables ||
    typeof backup.data.tables !==
      'object'
  ) {
    throw new Error(
      'El archivo no es un respaldo válido de Antojitos'
    );
  }

  const tables = {};

  ADMIN_BACKUP_TABLES.forEach(
    tableName => {
      const rows =
        backup.data.tables[
          tableName
        ];

      tables[tableName] =
        Array.isArray(rows)
          ? rows.slice(
              0,
              100000
            )
          : [];
    }
  );

  return tables;
}

async function restoreAdminBackupPayload(
  backup
) {
  const tables =
    validateBackupPayload(
      backup
    );

  const deleteOrder = [
    'calculadora_productos',
    'calculadora_calculos',
    'pedidos_archivados',
    'pedidos',
    'configuracion'
  ];

  const insertOrder = [
    'configuracion',
    'pedidos',
    'pedidos_archivados',
    'calculadora_calculos',
    'calculadora_productos'
  ];

  let restoredRows = 0;

  if (usePostgres) {
    const client =
      await pgPool.connect();

    try {
      await client.query(
        'BEGIN'
      );

      for (
        const tableName
        of deleteOrder
      ) {
        if (
          await postgresTableExists(
            client,
            tableName
          )
        ) {
          await client.query(
            `DELETE FROM ${quoteAdminIdentifier(tableName)}`
          );
        }
      }

      for (
        const tableName
        of insertOrder
      ) {
        restoredRows +=
          await restorePostgresTable(
            client,
            tableName,
            tables[tableName]
          );
      }

      await client.query(
        'COMMIT'
      );
    } catch (error) {
      await client
        .query('ROLLBACK')
        .catch(() => {});

      throw error;
    } finally {
      client.release();
    }
  } else {
    const transaction =
      db.transaction(() => {
        deleteOrder.forEach(
          tableName => {
            if (
              sqliteTableExists(
                tableName
              )
            ) {
              db.prepare(
                `DELETE FROM ${quoteAdminIdentifier(tableName)}`
              ).run();
            }
          }
        );

        insertOrder.forEach(
          tableName => {
            restoredRows +=
              restoreSqliteTable(
                tableName,
                tables[tableName]
              );
          }
        );
      });

    transaction();
  }

  return restoredRows;
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
  const source =
    value &&
    typeof value === 'object'
      ? value
      : {};

  const products =
    Array.isArray(source.products)
      ? source.products
          .map((item, index) => {
            const id = sanitizeText(
              item?.id ||
              `draft-item-${index + 1}`,
              100
            );

            const name = sanitizeText(
              item?.name || '',
              120
            );

            const qty = Math.max(
              0,
              sanitizeNumber(
                item?.qty
              )
            );

            const price = Math.max(
              0,
              sanitizeNumber(
                item?.price
              )
            );

            if (!id) return null;

            return {
              id,
              name,
              qty,
              price
            };
          })
          .filter(Boolean)
      : [];

  const todayKey =
    getMexicoCityDateKey();

  const salesStartDate =
    isValidDateKey(
      source.salesStartDate
    )
      ? source.salesStartDate
      : todayKey;

  const salesEndDate =
    isValidDateKey(
      source.salesEndDate
    )
      ? source.salesEndDate
      : salesStartDate;

  return {
    products,

    manualIncomeValue:
      Math.max(
        0,
        sanitizeNumber(
          source.manualIncomeValue ||
          0
        )
      ),

    useDashboardRevenue:
      Boolean(
        source.useDashboardRevenue
      ),

    salesStartDate,
    salesEndDate,

    updatedAt:
      Math.max(
        0,
        sanitizeNumber(
          source.updatedAt ||
          0
        )
      )
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
    if (nextPassword.length < 8) {
      return res.status(400).json({ ok: false, message: 'La contraseña debe tener al menos 8 caracteres' });
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

function normalizeStoredCalculatorProduct(item, index) {
  const source = item && typeof item === 'object' ? item : {};
  return {
    id: Number.isInteger(Number(source.id)) && Number(source.id) > 0
      ? Number(source.id)
      : index + 1,
    nombre: sanitizeText(source.nombre || source.name || '', 120),
    cantidad: Math.max(0, sanitizeNumber(source.cantidad ?? source.qty ?? 0)),
    costoUnitario: Math.max(0, sanitizeNumber(source.costoUnitario ?? source.costUnit ?? 0)),
    precioVentaUnitario: Math.max(0, sanitizeNumber(source.precioVentaUnitario ?? source.priceUnit ?? 0)),
    costoTotal: roundMoney(source.costoTotal ?? source.costTotal ?? 0),
    ventaTotal: roundMoney(source.ventaTotal ?? source.saleTotal ?? 0),
    gananciaEstimada: roundMoney(source.gananciaEstimada ?? 0),
    margenGanancia: roundMoney(source.margenGanancia ?? 0)
  };
}

function normalizeStoredCalculatorRecord(record, index) {
  const source = record && typeof record === 'object' ? record : {};
  const parsedId = Number(source.id);
  const parsedDate = new Date(source.fecha || Date.now());
  const productos = Array.isArray(source.productos)
    ? source.productos.map(normalizeStoredCalculatorProduct).filter(item => item.nombre)
    : [];

  return {
    id: Number.isInteger(parsedId) && parsedId > 0 ? parsedId : index + 1,
    fecha: Number.isNaN(parsedDate.getTime()) ? new Date().toISOString() : parsedDate.toISOString(),
    origen: ['manual', 'dashboard', 'sin_cantidad_inicial'].includes(source.origen)
      ? source.origen
      : 'manual',
    cantidadDisponible: roundMoney(source.cantidadDisponible ?? source.cantidad_disponible ?? 0),
    tipoCantidad: ['bruta', 'neta'].includes(source.tipoCantidad ?? source.tipo_cantidad)
      ? (source.tipoCantidad ?? source.tipo_cantidad)
      : 'bruta',
    cantidadProductos: Number(source.cantidadProductos ?? source.cantidad_productos ?? productos.length),
    costoTotal: roundMoney(source.costoTotal ?? source.costo_total ?? 0),
    ventaTotal: roundMoney(source.ventaTotal ?? source.venta_total ?? 0),
    gananciaEstimada: roundMoney(source.gananciaEstimada ?? source.ganancia_estimada ?? 0),
    margenGanancia: roundMoney(source.margenGanancia ?? source.margen_ganancia ?? 0),
    saldoRestante: roundMoney(source.saldoRestante ?? source.saldo_restante ?? 0),
    productos
  };
}

function buildStoredCalculatorRecord(payload, id, fecha = new Date().toISOString()) {
  return normalizeStoredCalculatorRecord({
    id,
    fecha,
    origen: payload.origen,
    cantidadDisponible: payload.cantidadDisponible,
    tipoCantidad: payload.tipoCantidad,
    cantidadProductos: payload.cantidadProductos,
    costoTotal: payload.costoTotal,
    ventaTotal: payload.ventaTotal,
    gananciaEstimada: payload.gananciaEstimada,
    margenGanancia: payload.margenGanancia,
    saldoRestante: payload.saldoRestante,
    productos: payload.productos.map((producto, index) => ({
      id: index + 1,
      nombre: producto.name,
      cantidad: producto.qty,
      costoUnitario: producto.costUnit,
      precioVentaUnitario: producto.priceUnit,
      costoTotal: producto.costTotal,
      ventaTotal: producto.saleTotal,
      gananciaEstimada: producto.gananciaEstimada,
      margenGanancia: producto.margenGanancia
    }))
  }, 0);
}

function readLegacyCalculatorHistoryFromSqlite() {
  if (usePostgres) return [];

  try {
    const rows = db.prepare('SELECT * FROM calculadora_calculos ORDER BY id DESC').all();
    return rows.map((row, index) => {
      const productos = db.prepare(
        'SELECT * FROM calculadora_productos WHERE calculo_id = ? ORDER BY id'
      ).all(row.id);

      return normalizeStoredCalculatorRecord({ ...row, productos }, index);
    });
  } catch (error) {
    console.warn('No se pudo migrar el historial anterior de calculadora:', error.message);
    return [];
  }
}

async function readCalculatorHistory() {
  const stored = await readConfigJson(CALCULATOR_HISTORY_KEY);
  if (Array.isArray(stored)) {
    return stored
      .map(normalizeStoredCalculatorRecord)
      .sort((a, b) => Number(b.id) - Number(a.id));
  }

  const legacy = readLegacyCalculatorHistoryFromSqlite();
  if (legacy.length) {
    await writeConfigJson(CALCULATOR_HISTORY_KEY, legacy);
  }
  return legacy;
}

async function writeCalculatorHistory(history) {
  const clean = (Array.isArray(history) ? history : [])
    .map(normalizeStoredCalculatorRecord)
    .sort((a, b) => Number(b.id) - Number(a.id));
  await writeConfigJson(CALCULATOR_HISTORY_KEY, clean);
  return clean;
}

router.post('/calculadora', requireAuth, async (req, res) => {
  try {
    const payload = normalizeCalculatorPayload(req.body || {});
    const history = await readCalculatorHistory();
    const nextId = history.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
    const calculo = buildStoredCalculatorRecord(payload, nextId);
    await writeCalculatorHistory([calculo, ...history]);
    return res.status(201).json({ ok: true, calculo });
  } catch (error) {
    console.error('Error guardando cálculo:', error);
    return res.status(500).json({ ok: false, message: 'No se pudo guardar el cálculo' });
  }
});

router.get('/calculadora', requireAuth, async (req, res) => {
  try {
    const calculos = await readCalculatorHistory();
    return res.json({ ok: true, calculos });
  } catch (error) {
    console.error('Error cargando cálculos:', error);
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

router.get('/calculadora/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, message: 'ID inválido' });
    }

    const history = await readCalculatorHistory();
    const calculo = history.find(item => Number(item.id) === id);
    if (!calculo) {
      return res.status(404).json({ ok: false, message: 'Cálculo no encontrado' });
    }
    return res.json({ ok: true, calculo });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo consultar el cálculo' });
  }
});

router.put('/calculadora/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, message: 'ID inválido' });
    }

    const payload = normalizeCalculatorPayload(req.body || {});
    const history = await readCalculatorHistory();
    const index = history.findIndex(item => Number(item.id) === id);
    if (index < 0) {
      return res.status(404).json({ ok: false, message: 'Cálculo no encontrado' });
    }

    const calculo = buildStoredCalculatorRecord(payload, id, history[index].fecha);
    history[index] = calculo;
    await writeCalculatorHistory(history);
    return res.json({ ok: true, calculo });
  } catch (error) {
    console.error('Error actualizando cálculo:', error);
    return res.status(500).json({ ok: false, message: 'No se pudo actualizar el cálculo' });
  }
});

router.delete('/calculadora/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, message: 'ID inválido' });
    }

    const history = await readCalculatorHistory();
    const next = history.filter(item => Number(item.id) !== id);
    if (next.length === history.length) {
      return res.status(404).json({ ok: false, message: 'Cálculo no encontrado' });
    }

    await writeCalculatorHistory(next);
    return res.json({ ok: true, deletedId: id });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'No se pudo eliminar el cálculo' });
  }
});


// Rutas antiguas de corte y respaldo eliminadas.
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

// === CALCULATOR_SALES_RANGE_BACKEND_V1 ===
router.get('/calculator-sales-range', requireAuth, async (req, res) => {
  try {
    await maybeArchiveAndResetDailyOrders();

    const requestedStart = sanitizeText(
      req.query?.startDate || '',
      10
    );

    const requestedEnd = sanitizeText(
      req.query?.endDate || '',
      10
    );

    const todayKey = getMexicoCityDateKey();

    const startDate =
      requestedStart || todayKey;

    const endDate =
      requestedEnd || startDate;

    if (
      !isValidDateKey(startDate) ||
      !isValidDateKey(endDate)
    ) {
      return res.status(400).json({
        ok: false,
        message:
          'Fechas invalidas. Usa formato YYYY-MM-DD'
      });
    }

    if (startDate > endDate) {
      return res.status(400).json({
        ok: false,
        message:
          'La fecha inicial no puede ser posterior a la fecha final'
      });
    }

    const startRange =
      buildUtcRangeFromDateKey(
        startDate,
        MEXICO_CITY_TZ_OFFSET_MINUTES
      );

    const endRange =
      buildUtcRangeFromDateKey(
        endDate,
        MEXICO_CITY_TZ_OFFSET_MINUTES
      );

    const [
      activeSummary,
      archivedSummary
    ] = await Promise.all([
      querySingle(
        `
          SELECT
            COALESCE(
              SUM(
                CASE
                  WHEN estado != 'Cancelado'
                    THEN total
                  ELSE 0
                END
              ),
              0
            ) AS total,

            COALESCE(
              SUM(
                CASE
                  WHEN estado != 'Cancelado'
                    THEN 1
                  ELSE 0
                END
              ),
              0
            ) AS order_count

          FROM pedidos
          WHERE fecha >= ?
            AND fecha < ?
        `,
        [
          startRange.startIso,
          endRange.endIso
        ]
      ),

      querySingle(
        `
          SELECT
            COALESCE(
              SUM(
                CASE
                  WHEN estado != 'Cancelado'
                    THEN total
                  ELSE 0
                END
              ),
              0
            ) AS total,

            COALESCE(
              SUM(
                CASE
                  WHEN estado != 'Cancelado'
                    THEN 1
                  ELSE 0
                END
              ),
              0
            ) AS order_count

          FROM pedidos_archivados
          WHERE fecha >= ?
            AND fecha <= ?
        `,
        [
          startDate,
          endDate
        ]
      )
    ]);

    const activeRevenue = roundMoney(
      Number(activeSummary?.total || 0)
    );

    const archivedRevenue = roundMoney(
      Number(archivedSummary?.total || 0)
    );

    const totalRevenue = roundMoney(
      activeRevenue + archivedRevenue
    );

    const activeOrders = Number(
      activeSummary?.order_count || 0
    );

    const archivedOrders = Number(
      archivedSummary?.order_count || 0
    );

    return res.json({
      ok: true,

      period: {
        startDate,
        endDate,
        timezone:
          'America/Mexico_City'
      },

      summary: {
        totalRevenue,
        orderCount:
          activeOrders + archivedOrders,
        activeRevenue,
        archivedRevenue,
        activeOrders,
        archivedOrders
      }
    });
  } catch (error) {
    console.error(
      'Error calculando ventas para la calculadora:',
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        'No se pudieron calcular las ventas del periodo'
    });
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
  parseProductos(row.productos).forEach(item => {
    const name = sanitizeText(
      item?.name ||
      item?.nombre ||
      'Producto',
      140
    );

    const normalizedName =
      normalizeSoldProductName(name);

    const quantity = Math.max(
      0,
      Number(
        item?.qty ??
        item?.cantidad ??
        0
      )
    );

    const unitPrice = Math.max(
      0,
      Number(
        item?.price ??
        item?.precio ??
        0
      )
    );

    if (
      !normalizedName ||
      quantity <= 0
    ) {
      return;
    }

    const totalAmount = roundMoney(
      quantity * unitPrice
    );

    const current =
      aggregate.get(normalizedName) || {
        name,
        quantitySold: 0,
        totalAmount: 0
      };

    current.quantitySold += quantity;

    current.totalAmount = roundMoney(
      current.totalAmount + totalAmount
    );

    aggregate.set(
      normalizedName,
      current
    );
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
  console.error(
    'Error calculando productos vendidos:',
    error
  );

  return res.status(500).json({
    ok: false,
    message:
      'No se pudieron calcular los productos vendidos'
  });
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

router.get('/stats', requireAuth, async (req, res) => {
  try {
    await maybeArchiveAndResetDailyOrders();

    const requestedDate = sanitizeText(
      req.query?.date || '',
      10
    );

    const requestedOffset = Number(
      req.query?.tzOffset
    );

    const tzOffset = Number.isFinite(requestedOffset)
      ? requestedOffset
      : MEXICO_CITY_TZ_OFFSET_MINUTES;

    const effectiveDate = isValidDateKey(requestedDate)
      ? requestedDate
      : getMexicoCityDateKey();

    const dayRange = buildUtcRangeFromDateKey(
      effectiveDate,
      tzOffset
    );

    const monthRange = buildUtcMonthRangeFromDateKey(
      effectiveDate,
      tzOffset
    );

    const [year, month] = effectiveDate
      .split('-')
      .map(Number);

    const monthStartKey =
      `${year}-${String(month).padStart(2, '0')}-01`;

    const nextMonthStartKey =
      month === 12
        ? `${year + 1}-01-01`
        : `${year}-${String(month + 1).padStart(2, '0')}-01`;

    const [
      activeDay,
      archivedDay,
      activeMonth,
      archivedMonth,
      activeHistorical,
      archivedHistorical,
      activeProducts,
      archivedProducts
    ] = await Promise.all([
      querySingle(
        `
          SELECT
            COUNT(*) AS total_pedidos,

            COALESCE(SUM(
              CASE
                WHEN estado IN (
                  'Pendiente',
                  'Confirmado',
                  'Preparando',
                  'En camino'
                )
                THEN 1
                ELSE 0
              END
            ), 0) AS pendientes,

            COALESCE(SUM(
              CASE
                WHEN estado = 'Entregado'
                THEN 1
                ELSE 0
              END
            ), 0) AS entregados,

            COALESCE(SUM(
              CASE
                WHEN estado != 'Cancelado'
                THEN total
                ELSE 0
              END
            ), 0) AS ventas,

            COALESCE(SUM(
              CASE
                WHEN estado != 'Cancelado'
                THEN 1
                ELSE 0
              END
            ), 0) AS pedidos_validos

          FROM pedidos
          WHERE fecha >= ?
            AND fecha < ?
        `,
        [
          dayRange.startIso,
          dayRange.endIso
        ]
      ),

      querySingle(
        `
          SELECT
            COUNT(*) AS total_pedidos,

            COALESCE(SUM(
              CASE
                WHEN estado IN (
                  'Pendiente',
                  'Confirmado',
                  'Preparando',
                  'En camino'
                )
                THEN 1
                ELSE 0
              END
            ), 0) AS pendientes,

            COALESCE(SUM(
              CASE
                WHEN estado = 'Entregado'
                THEN 1
                ELSE 0
              END
            ), 0) AS entregados,

            COALESCE(SUM(
              CASE
                WHEN estado != 'Cancelado'
                THEN total
                ELSE 0
              END
            ), 0) AS ventas,

            COALESCE(SUM(
              CASE
                WHEN estado != 'Cancelado'
                THEN 1
                ELSE 0
              END
            ), 0) AS pedidos_validos

          FROM pedidos_archivados
          WHERE fecha = ?
        `,
        [effectiveDate]
      ),

      querySingle(
        `
          SELECT COALESCE(SUM(total), 0) AS total
          FROM pedidos
          WHERE fecha >= ?
            AND fecha < ?
            AND estado != 'Cancelado'
        `,
        [
          monthRange.startIso,
          monthRange.endIso
        ]
      ),

      querySingle(
        `
          SELECT COALESCE(SUM(total), 0) AS total
          FROM pedidos_archivados
          WHERE fecha >= ?
            AND fecha < ?
            AND estado != 'Cancelado'
        `,
        [
          monthStartKey,
          nextMonthStartKey
        ]
      ),

      querySingle(
        `
          SELECT COALESCE(SUM(total), 0) AS total
          FROM pedidos
          WHERE estado != 'Cancelado'
        `
      ),

      querySingle(
        `
          SELECT COALESCE(SUM(total), 0) AS total
          FROM pedidos_archivados
          WHERE estado != 'Cancelado'
        `
      ),

      queryAll(
        `
          SELECT productos
          FROM pedidos
          WHERE fecha >= ?
            AND fecha < ?
            AND estado != 'Cancelado'
        `,
        [
          dayRange.startIso,
          dayRange.endIso
        ]
      ),

      queryAll(
        `
          SELECT productos
          FROM pedidos_archivados
          WHERE fecha = ?
            AND estado != 'Cancelado'
        `,
        [effectiveDate]
      )
    ]);

    const totalPedidos =
      Number(activeDay?.total_pedidos || 0) +
      Number(archivedDay?.total_pedidos || 0);

    const pendientes =
      Number(activeDay?.pendientes || 0) +
      Number(archivedDay?.pendientes || 0);

    const entregados =
      Number(activeDay?.entregados || 0) +
      Number(archivedDay?.entregados || 0);

    const pedidosValidos =
      Number(activeDay?.pedidos_validos || 0) +
      Number(archivedDay?.pedidos_validos || 0);

    const ventasDia = roundMoney(
      Number(activeDay?.ventas || 0) +
      Number(archivedDay?.ventas || 0)
    );

    const ventasMes = roundMoney(
      Number(activeMonth?.total || 0) +
      Number(archivedMonth?.total || 0)
    );

    const totalVendido = roundMoney(
      Number(activeHistorical?.total || 0) +
      Number(archivedHistorical?.total || 0)
    );

    const promedioPedido =
      pedidosValidos > 0
        ? roundMoney(ventasDia / pedidosValidos)
        : 0;

    const productCount = new Map();

    [
      ...activeProducts,
      ...archivedProducts
    ].forEach(row => {
      parseProductos(row.productos).forEach(item => {
        const name = sanitizeText(
          item?.name || item?.nombre || '',
          140
        );

        const qty = Math.max(
          0,
          Number(
            item?.qty ??
            item?.cantidad ??
            0
          )
        );

        if (!name || qty <= 0) return;

        productCount.set(
          name,
          (productCount.get(name) || 0) + qty
        );
      });
    });

    let productoMasVendido = 'Sin datos';
    let productoCantidad = 0;

    for (const [name, qty] of productCount.entries()) {
      if (qty > productoCantidad) {
        productoMasVendido = name;
        productoCantidad = qty;
      }
    }

    return res.json({
      ok: true,

      period: {
        date: effectiveDate,
        timezone: 'America/Mexico_City'
      },

      stats: {
        totalPedidos,
        pedidosPendientes: pendientes,
        pedidosEntregados: entregados,
        ventasDia,
        ventasMes,
        totalVendido,
        promedioPorPedido: promedioPedido,
        productoMasVendido,
        productoMasVendidoCantidad:
          productoCantidad
      }
    });
  } catch (error) {
    console.error(
      'Error calculando estadísticas del dashboard:',
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        'No se pudieron calcular estadísticas'
    });
  }
});

module.exports = router;
