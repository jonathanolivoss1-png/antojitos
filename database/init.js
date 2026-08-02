require('dotenv').config();

const bcrypt = require('bcryptjs');
const db = require('./db');

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

function upsertConfig(clave, valor) {
  db.prepare(`
    INSERT INTO configuracion (clave, valor)
    VALUES (?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor
  `).run(clave, JSON.stringify(valor));
}

function seedGlobalConfigIfMissing() {
  const hasContent = db.prepare('SELECT 1 FROM configuracion WHERE clave = ? LIMIT 1').get(CONFIG_KEYS.content);
  const hasPromotions = db.prepare('SELECT 1 FROM configuracion WHERE clave = ? LIMIT 1').get(CONFIG_KEYS.promotions);
  const hasProducts = db.prepare('SELECT 1 FROM configuracion WHERE clave = ? LIMIT 1').get(CONFIG_KEYS.products);

  if (!hasContent) upsertConfig(CONFIG_KEYS.content, DEFAULT_GLOBAL_CONTENT);
  if (!hasPromotions) upsertConfig(CONFIG_KEYS.promotions, DEFAULT_GLOBAL_PROMOTIONS);
  if (!hasProducts) upsertConfig(CONFIG_KEYS.products, DEFAULT_GLOBAL_PRODUCTS);
}

function initDatabase() {
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
      clienteToken TEXT NOT NULL DEFAULT '',
      cliente TEXT NOT NULL,
      telefono TEXT,
      direccion TEXT,
      tipoEntrega TEXT NOT NULL,
      productos TEXT NOT NULL,
      subtotal REAL NOT NULL DEFAULT 0,
      envio REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'Pendiente',
      fecha TEXT NOT NULL
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
  const hasClienteToken = pedidoColumns.some(column => column.name === 'clienteToken');
  if (!hasClienteToken) {
    db.exec("ALTER TABLE pedidos ADD COLUMN clienteToken TEXT NOT NULL DEFAULT '';");
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_token ON pedidos (clienteToken);');

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

  seedGlobalConfigIfMissing();
}

if (require.main === module) {
  try {
    initDatabase();
    console.log('Base de datos inicializada correctamente.');
  } catch (error) {
    console.error('Error inicializando base de datos:', error);
    process.exit(1);
  }
}

module.exports = initDatabase;
