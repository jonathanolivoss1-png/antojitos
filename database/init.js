require('dotenv').config();

const bcrypt = require('bcryptjs');
const db = require('./db');
const pgPool = require('../postgres');
const usePostgres = Boolean(pgPool);
const { broadcastAdminEvent } = require('../realtime/events');

const CONFIG_KEYS = {
  content: 'site_content_v1',
  promotions: 'site_promotions_v1',
  products: 'site_products_v1'
};

const DEFAULT_GLOBAL_CONTENT = {
  heroBadge: 'Comida tradicional mexicana',
  heroTitle: 'El sabor tradicional mexicano en cada bocado',
  heroText: 'Pozole, gorditas, tacos de cecina, pancita, sopes y antojitos preparados con la receta de la casa.',
  recommendations: ['Tacos de cecina', 'Gorditas rellenas', 'Pozole de la casa', 'Bebidas refrescantes']
};

const DEFAULT_GLOBAL_PROMOTIONS = [
  {
    id: 'promo-pozole',
    title: 'Fin de semana pozolero',
    text: 'Activa esta promo desde el panel para destacar tu pozole, pancita o cualquier antojo especial de temporada.',
    chip: 'Destacado',
    active: true
  },
  {
    id: 'promo-envio',
    title: 'Pedidos listos por WhatsApp',
    text: 'El carrito y el historial guardan tu pedido para repetirlo mas rapido y seguir el flujo actual de WhatsApp.',
    chip: 'Servicio',
    active: true
  }
];

const DEFAULT_GLOBAL_PRODUCTS = [
  {
    id: 'pozole',
    name: 'Pozole',
    description: 'Tradicional pozole de maiz acompanado de lechuga, cebolla, limon y tacos dorados.',
    image: 'https://images.unsplash.com/photo-1613514785940-daed07799d9b?auto=format&fit=crop&w=1200&q=80',
    category: 'antojitos',
    tag: 'Especialidad',
    note: 'Incluye guarniciones tradicionales.',
    priceLabel: '$80',
    active: true,
    available: true,
    options: [
      { id: 'maciza', name: 'Puerco maciza', price: 80 },
      { id: 'surtido', name: 'Puerco surtido', price: 80 },
      { id: 'pollo', name: 'Pollo', price: 80 }
    ]
  },
  {
    id: 'quesadillas',
    name: 'Quesadillas',
    description: 'Elige el relleno que mas te guste y si las prefieres fritas o al comal.',
    image: 'https://images.unsplash.com/photo-1599974579688-8dbdd335c77f?auto=format&fit=crop&w=1200&q=80',
    category: 'antojitos',
    tag: 'Personaliza',
    note: 'Preparacion disponible al comal o frita.',
    priceLabel: '$25',
    active: true,
    available: true,
    choices: ['Frita', 'Comal'],
    options: [
      { id: 'queso', name: 'Queso', price: 25 },
      { id: 'pollo', name: 'Pollo', price: 25 },
      { id: 'tinga', name: 'Tinga', price: 25 },
      { id: 'champinones', name: 'Champinones', price: 25 },
      { id: 'papas-chorizo', name: 'Papas con chorizo', price: 25 },
      { id: 'chicharron', name: 'Chicharron prensado', price: 25 }
    ]
  },
  {
    id: 'pancita',
    name: 'Pancita',
    description: 'Servida con el sabor tradicional de la casa.',
    image: 'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=1200&q=80',
    category: 'antojitos',
    tag: 'A elegir',
    note: 'Acompanada de tortillas hechas a mano.',
    priceLabel: '$100 / $130',
    active: true,
    available: true,
    options: [
      { id: 'plato', name: 'Plato', price: 100 },
      { id: 'litro', name: 'Litro', price: 130 }
    ]
  },
  {
    id: 'gorditas',
    name: 'Gorditas',
    description: 'Elige tu relleno y arma tu antojo favorito con sabor casero.',
    image: 'https://images.unsplash.com/photo-1625943555419-56a2cb596640?auto=format&fit=crop&w=1200&q=80',
    category: 'gorditas',
    tag: 'Favoritas',
    note: 'Pregunta por frita o al comal al confirmar tu pedido.',
    priceLabel: '$25 / +$30',
    active: true,
    available: true,
    options: [
      { id: 'frijol', name: 'Frijol', price: 25 },
      { id: 'chales', name: 'Chales', price: 25 },
      { id: 'guisado', name: 'Agregar guisado', price: 30 }
    ]
  },
  {
    id: 'tacos-cecina',
    name: 'Tacos de Cecina',
    description: 'Hechos al momento con sabor tradicional y acompanados de lo que mas te guste.',
    image: 'https://images.unsplash.com/photo-1615870216519-2f9fa575fa5c?auto=format&fit=crop&w=1200&q=80',
    category: 'tacos',
    tag: 'Mas pedidos',
    note: 'Con papas fritas.',
    priceLabel: '$25 / $30',
    active: true,
    available: true,
    options: [
      { id: 'sencillos', name: 'Sencillos', price: 25 },
      { id: 'queso', name: 'Con queso', price: 30 },
      { id: 'campechanas', name: 'Campechanas', price: 30 }
    ]
  },
  {
    id: 'sopes',
    name: 'Sopes',
    description: 'Listos para pedir con tu opcion favorita.',
    image: 'https://images.unsplash.com/photo-1611250188496-e966043a0629?auto=format&fit=crop&w=1200&q=80',
    category: 'antojitos',
    tag: 'Antojo',
    note: 'Base casera con toppings frescos.',
    priceLabel: '$20 / $25',
    active: true,
    available: true,
    options: [
      { id: 'sencillos', name: 'Sencillos', price: 20 },
      { id: 'guisado', name: 'Con guisado', price: 25 }
    ]
  },
  {
    id: 'bebidas',
    name: 'Bebidas de la casa',
    description: 'Refrescos, aguas frescas y bebidas frias para acompanar tus antojitos favoritos.',
    image: 'https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?auto=format&fit=crop&w=1200&q=80',
    category: 'bebidas',
    tag: 'Refrescante',
    note: 'Consulta sabores disponibles del dia.',
    priceLabel: '$25',
    active: true,
    available: true,
    options: [
      { id: 'aguas-frescas', name: 'Aguas frescas', price: 25 }
    ]
  }
];

const DAILY_ARCHIVE_STATE_KEY = 'daily_archive_state_v1';
const MEXICO_CITY_TZ_OFFSET_MINUTES = 360;

async function upsertConfig(clave, valor) {
  const payload = JSON.stringify(valor);

  if (usePostgres) {
    await pgPool.query(`
      INSERT INTO configuracion (clave, valor)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor
    `, [clave, payload]);
    return;
  }

  db.prepare(`
    INSERT INTO configuracion (clave, valor)
    VALUES (?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor
  `).run(clave, payload);
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

async function readDailyArchiveState() {
  if (usePostgres) {
    const result = await pgPool.query(
      'SELECT valor FROM configuracion WHERE clave = $1 LIMIT 1',
      [DAILY_ARCHIVE_STATE_KEY]
    );

    const value = result.rows[0]?.valor;
    if (!value) return { lastProcessedDate: null };
    return typeof value === 'object' ? value : JSON.parse(String(value)) || {};
  }

  const row = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(DAILY_ARCHIVE_STATE_KEY);
  if (!row?.valor) return { lastProcessedDate: null };
  try {
    const parsed = JSON.parse(row.valor);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeDailyArchiveState(value) {
  await upsertConfig(DAILY_ARCHIVE_STATE_KEY, value);
}

function archiveOrdersForDate(dateKey) {
  if (!isValidDateKey(dateKey)) return { archivedCount: 0 };

  const range = buildUtcRangeFromDateKey(dateKey, MEXICO_CITY_TZ_OFFSET_MINUTES);
  const rows = db.prepare('SELECT * FROM pedidos WHERE fecha >= ? AND fecha < ? ORDER BY datetime(fecha) DESC, id DESC').all(range.startIso, range.endIso);

  if (!rows.length) {
    return { archivedCount: 0 };
  }

 const insert = db.prepare(`
  INSERT INTO pedidos_archivados (
    fecha,
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
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

  const tx = db.transaction(items => {
    items.forEach(order => {
      insert.run(
        dateKey,
        order.cliente_token || order.clienteToken || '',
        order.cliente || '',
        order.telefono || '',
        order.direccion || '',
        order.tipoEntrega || '',
        order.productos || '[]',
        Number(order.subtotal || 0),
        Number(order.envio || 0),
        Number(order.total || 0),
        order.estado || 'Pendiente',
        new Date().toISOString(),
        order.id
      );
    });
  });

  tx(rows);

  const result = db.prepare('DELETE FROM pedidos WHERE fecha >= ? AND fecha < ?').run(range.startIso, range.endIso);
  const remaining = db.prepare('SELECT id FROM pedidos LIMIT 1').get();
  if (!remaining) {
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'pedidos'").run();
  }

  broadcastAdminEvent('orders-updated', { ts: Date.now(), reason: 'auto-archived-day' });

  return { archivedCount: Number(result.changes || 0) };
}

async function seedGlobalConfigIfMissing() {
  if (usePostgres) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS configuracion (
        clave TEXT PRIMARY KEY,
        valor JSONB NOT NULL
      )
    `);

    const result = await pgPool.query(
      'SELECT clave FROM configuracion WHERE clave = ANY($1)',
      [[CONFIG_KEYS.content, CONFIG_KEYS.promotions, CONFIG_KEYS.products]]
    );

    const existingKeys = new Set(result.rows.map(row => row.clave));
    if (!existingKeys.has(CONFIG_KEYS.content)) await upsertConfig(CONFIG_KEYS.content, DEFAULT_GLOBAL_CONTENT);
    if (!existingKeys.has(CONFIG_KEYS.promotions)) await upsertConfig(CONFIG_KEYS.promotions, DEFAULT_GLOBAL_PROMOTIONS);
    if (!existingKeys.has(CONFIG_KEYS.products)) await upsertConfig(CONFIG_KEYS.products, DEFAULT_GLOBAL_PRODUCTS);
    return;
  }

  const hasContent = db.prepare('SELECT 1 FROM configuracion WHERE clave = ? LIMIT 1').get(CONFIG_KEYS.content);
  const hasPromotions = db.prepare('SELECT 1 FROM configuracion WHERE clave = ? LIMIT 1').get(CONFIG_KEYS.promotions);
  const hasProducts = db.prepare('SELECT 1 FROM configuracion WHERE clave = ? LIMIT 1').get(CONFIG_KEYS.products);

  if (!hasContent) await upsertConfig(CONFIG_KEYS.content, DEFAULT_GLOBAL_CONTENT);
  if (!hasPromotions) await upsertConfig(CONFIG_KEYS.promotions, DEFAULT_GLOBAL_PROMOTIONS);
  if (!hasProducts) await upsertConfig(CONFIG_KEYS.products, DEFAULT_GLOBAL_PRODUCTS);
}

async function maybeArchiveAndResetDailyOrders() {
  const todayKey = getMexicoCityDateKey();
  const state = await readDailyArchiveState();
  const lastProcessedDate = state?.lastProcessedDate;

  if (!lastProcessedDate) {
    await writeDailyArchiveState({ lastProcessedDate: todayKey });
    return { archivedCount: 0, initialized: true, date: todayKey };
  }

  if (lastProcessedDate === todayKey) {
    return { archivedCount: 0, skipped: true, date: todayKey };
  }

  const archived = await archiveOrdersForDate(lastProcessedDate);
  await writeDailyArchiveState({ lastProcessedDate: todayKey });
  return { ...archived, date: todayKey, archivedDate: lastProcessedDate };
}

async function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL
    );

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
      tipo_entrega TEXT NOT NULL,
      productos TEXT NOT NULL,
      subtotal REAL NOT NULL DEFAULT 0,
      envio REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'Pendiente',
      fecha TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pedidos_archivados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT NOT NULL,
      cliente_token TEXT NOT NULL DEFAULT '',
      cliente TEXT NOT NULL,
      telefono TEXT,
      direccion TEXT,
      tipo_entrega TEXT NOT NULL,
      productos TEXT NOT NULL,
      subtotal REAL NOT NULL DEFAULT 0,
      envio REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'Pendiente',
      creado_en TEXT NOT NULL,
      origen_pedido_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS calculadora_calculos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha TEXT NOT NULL,
      origen TEXT NOT NULL DEFAULT 'manual',
      cantidad_disponible REAL NOT NULL DEFAULT 0,
      tipo_cantidad TEXT NOT NULL DEFAULT 'bruta',
      cantidad_productos INTEGER NOT NULL DEFAULT 0,
      costo_total REAL NOT NULL DEFAULT 0,
      venta_total REAL NOT NULL DEFAULT 0,
      ganancia_estimada REAL NOT NULL DEFAULT 0,
      margen_ganancia REAL NOT NULL DEFAULT 0,
      saldo_restante REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS calculadora_productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      calculo_id INTEGER NOT NULL,
      nombre TEXT NOT NULL,
      cantidad REAL NOT NULL DEFAULT 0,
      costo_unitario REAL NOT NULL DEFAULT 0,
      precio_venta_unitario REAL NOT NULL DEFAULT 0,
      costo_total REAL NOT NULL DEFAULT 0,
      venta_total REAL NOT NULL DEFAULT 0,
      ganancia_estimada REAL NOT NULL DEFAULT 0,
      margen_ganancia REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (calculo_id) REFERENCES calculadora_calculos(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pedidos_estado ON pedidos (estado);
    CREATE INDEX IF NOT EXISTS idx_pedidos_fecha ON pedidos (fecha);
  `);

  const pedidoColumns = db.prepare('PRAGMA table_info(pedidos)').all();
  const hasClienteTokenSnake = pedidoColumns.some(column => column.name === 'cliente_token');
  const hasClienteTokenCamel = pedidoColumns.some(column => column.name === 'clienteToken');
  const hasTipoEntregaSnake = pedidoColumns.some(column => column.name === 'tipo_entrega');
  const hasTipoEntregaCamel = pedidoColumns.some(column => column.name === 'tipoEntrega');

  if (!hasClienteTokenSnake) {
    db.exec("ALTER TABLE pedidos ADD COLUMN cliente_token TEXT NOT NULL DEFAULT '';");
    if (hasClienteTokenCamel) {
      db.exec("UPDATE pedidos SET cliente_token = clienteToken WHERE clienteToken IS NOT NULL AND clienteToken != '';");
    }
  }

  if (!hasTipoEntregaSnake) {
    db.exec("ALTER TABLE pedidos ADD COLUMN tipo_entrega TEXT NOT NULL DEFAULT 'Pendiente';");
    if (hasTipoEntregaCamel) {
      db.exec("UPDATE pedidos SET tipo_entrega = tipoEntrega WHERE tipoEntrega IS NOT NULL AND tipoEntrega != '';");
    }
  }

  if (hasClienteTokenCamel && hasTipoEntregaCamel) {
    db.exec('DROP TABLE IF EXISTS pedidos_new;');
    db.exec(`
      CREATE TABLE pedidos_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cliente_token TEXT NOT NULL DEFAULT '',
        cliente TEXT NOT NULL,
        telefono TEXT,
        direccion TEXT,
        tipo_entrega TEXT NOT NULL DEFAULT 'Pendiente',
        productos TEXT NOT NULL,
        subtotal REAL NOT NULL DEFAULT 0,
        envio REAL NOT NULL DEFAULT 0,
        total REAL NOT NULL DEFAULT 0,
        estado TEXT NOT NULL DEFAULT 'Pendiente',
        fecha TEXT NOT NULL
      );
    `);

    db.exec(`
      INSERT INTO pedidos_new (
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
      SELECT
        COALESCE(cliente_token, clienteToken, '') AS cliente_token,
        cliente,
        telefono,
        direccion,
        COALESCE(tipo_entrega, tipoEntrega, 'Pendiente') AS tipo_entrega,
        productos,
        subtotal,
        envio,
        total,
        estado,
        fecha
      FROM pedidos;
    `);

    db.exec('DROP TABLE pedidos;');
    db.exec('ALTER TABLE pedidos_new RENAME TO pedidos;');
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_token ON pedidos (cliente_token);');

  const archivedColumns = db.prepare('PRAGMA table_info(pedidos_archivados)').all();
  const hasArchivedClienteTokenSnake = archivedColumns.some(column => column.name === 'cliente_token');
  const hasArchivedClienteTokenCamel = archivedColumns.some(column => column.name === 'clienteToken');
  const hasArchivedTipoEntregaSnake = archivedColumns.some(column => column.name === 'tipo_entrega');
  const hasArchivedTipoEntregaCamel = archivedColumns.some(column => column.name === 'tipoEntrega');

  if (!hasArchivedClienteTokenSnake) {
    db.exec("ALTER TABLE pedidos_archivados ADD COLUMN cliente_token TEXT NOT NULL DEFAULT '';");
    if (hasArchivedClienteTokenCamel) {
      db.exec("UPDATE pedidos_archivados SET cliente_token = clienteToken WHERE clienteToken IS NOT NULL AND clienteToken != '';");
    }
  }

  if (!hasArchivedTipoEntregaSnake) {
    db.exec("ALTER TABLE pedidos_archivados ADD COLUMN tipo_entrega TEXT NOT NULL DEFAULT 'Pendiente';");
    if (hasArchivedTipoEntregaCamel) {
      db.exec("UPDATE pedidos_archivados SET tipo_entrega = tipoEntrega WHERE tipoEntrega IS NOT NULL AND tipoEntrega != '';");
    }
  }

  if (hasArchivedClienteTokenCamel && hasArchivedTipoEntregaCamel) {
    db.exec('DROP TABLE IF EXISTS pedidos_archivados_new;');
    db.exec(`
      CREATE TABLE pedidos_archivados_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fecha TEXT NOT NULL,
        cliente_token TEXT NOT NULL DEFAULT '',
        cliente TEXT NOT NULL,
        telefono TEXT,
        direccion TEXT,
        tipo_entrega TEXT NOT NULL DEFAULT 'Pendiente',
        productos TEXT NOT NULL,
        subtotal REAL NOT NULL DEFAULT 0,
        envio REAL NOT NULL DEFAULT 0,
        total REAL NOT NULL DEFAULT 0,
        estado TEXT NOT NULL DEFAULT 'Pendiente',
        creado_en TEXT NOT NULL,
        origen_pedido_id INTEGER
      );
    `);

    db.exec(`
      INSERT INTO pedidos_archivados_new (
        fecha,
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
      SELECT
        fecha,
        COALESCE(cliente_token, clienteToken, '') AS cliente_token,
        cliente,
        telefono,
        direccion,
        COALESCE(tipo_entrega, tipoEntrega, 'Pendiente') AS tipo_entrega,
        productos,
        subtotal,
        envio,
        total,
        estado,
        creado_en,
        origen_pedido_id
      FROM pedidos_archivados;
    `);

    db.exec('DROP TABLE pedidos_archivados;');
    db.exec('ALTER TABLE pedidos_archivados_new RENAME TO pedidos_archivados;');
  }

  const adminUser = 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS || '123456';
  const hash = bcrypt.hashSync(adminPassword, 10);

  const existing = db.prepare('SELECT id, password FROM usuarios WHERE usuario = ?').get(adminUser);
  if (!existing) {
    db.prepare('INSERT INTO usuarios (usuario, password) VALUES (?, ?)').run(adminUser, hash);
    console.log('Usuario admin inicial creado.');
  } else if (existing.password !== hash) {
    db.prepare('UPDATE usuarios SET password = ? WHERE usuario = ?').run(hash, adminUser);
    console.log('Contraseña de usuario admin actualizada.');
  }

  await seedGlobalConfigIfMissing();
}

if (require.main === module) {
  initDatabase()
    .then(() => {
      console.log('Base de datos inicializada correctamente.');
    })
    .catch((error) => {
      console.error('Error inicializando base de datos:', error);
      process.exit(1);
    });
}

module.exports = initDatabase;
module.exports.initDatabase = initDatabase;
module.exports.maybeArchiveAndResetDailyOrders = maybeArchiveAndResetDailyOrders;
