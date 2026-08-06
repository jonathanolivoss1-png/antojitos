'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root =
  path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(
    path.join(root, relativePath),
    'utf8'
  );
}

function includes(
  text,
  value,
  message
) {
  assert.ok(
    text.includes(value),
    message
  );
}

const server =
  read('server.js');

const kitchenRoute =
  read('routes/cocina.js');

const idempotency =
  read(
    'middleware/idempotencia-pedidos.js'
  );

const kitchenClient =
  read('public/cocina/cocina.js');

const kitchenHtml =
  read('public/cocina/index.html');

const adminKitchen =
  read('public/admin/cocina-admin.js');

includes(
  server,
  "app.use('/api/cocina', cocinaRoutes)",
  'Cocina debe estar montada en /api/cocina'
);

includes(
  server,
  "createOrderIdempotency",
  'El servidor debe cargar la protección contra duplicados'
);

const publicProtection =
  server.indexOf(
    "app.use('/api/pedidos', publicOrderIdempotency)"
  );

const publicOrders =
  server.indexOf(
    "app.use('/api/pedidos', pedidosRoutes)"
  );

assert.ok(
  publicProtection >= 0 &&
  publicOrders >= 0 &&
  publicProtection < publicOrders,
  'La protección pública debe ejecutarse antes de pedidosRoutes'
);

const personalProtection =
  server.indexOf(
    "app.use('/api/meseros/orders', personalOrderIdempotency)"
  );

const personalOrders =
  server.indexOf(
    "app.use('/api/meseros', meserosRoutes)"
  );

assert.ok(
  personalProtection >= 0 &&
  personalOrders >= 0 &&
  personalProtection < personalOrders,
  'La protección de Personal debe ejecutarse antes de meserosRoutes'
);

includes(
  kitchenRoute,
  "router.get(\n  '/orders',\n  requireKitchen",
  'Los pedidos de Cocina deben exigir sesión de Cocina'
);

includes(
  kitchenRoute,
  "router.get(\n  '/admin/users',\n  requireAuth",
  'La gestión de usuarios de Cocina debe exigir sesión Admin'
);

includes(
  kitchenRoute,
  "'Pendiente',\n  'Preparando',\n  'Listo'",
  'Los estados de preparación deben estar limitados'
);

includes(
  kitchenRoute,
  "WHERE p.estado = 'Confirmado'",
  'Cocina solamente debe mostrar pedidos Confirmados'
);

includes(
  kitchenRoute,
  'trg_reset_preparacion_al_corregir',
  'Una corrección debe regresar la preparación a Pendiente'
);

includes(
  idempotency,
  'pedidos_idempotencia',
  'La protección debe tener almacenamiento persistente'
);

includes(
  idempotency,
  "state: 'processing'",
  'La protección debe bloquear solicitudes simultáneas'
);

includes(
  kitchenClient,
  '/api/cocina/orders',
  'La interfaz debe consultar únicamente la API de Cocina'
);

assert.ok(
  !kitchenHtml.includes('/api/admin/') &&
  !kitchenClient.includes('/api/admin/'),
  'La aplicación de Cocina no debe consumir rutas administrativas'
);

includes(
  adminKitchen,
  '/api/cocina/admin/users',
  'La gestión Admin debe usar las rutas protegidas de Cocina'
);

const {
  stableStringify,
  requestFingerprint
} = require(
  '../middleware/idempotencia-pedidos'
);

assert.strictEqual(
  stableStringify({
    b: 2,
    a: 1,
    requestId: 'uno'
  }),
  stableStringify({
    requestId: 'dos',
    a: 1,
    b: 2
  }),
  'El requestId no debe cambiar la huella del contenido'
);

const fakeRequest = {
  method: 'POST',
  body: {
    total: 100,
    productos: [
      {
        nombre: 'Pambazo',
        cantidad: 2
      }
    ]
  }
};

assert.strictEqual(
  requestFingerprint(
    fakeRequest,
    'public',
    '127.0.0.1'
  ),
  requestFingerprint(
    {
      ...fakeRequest,
      body: {
        productos: [
          {
            cantidad: 2,
            nombre: 'Pambazo'
          }
        ],
        total: 100
      }
    },
    'public',
    '127.0.0.1'
  ),
  'La huella debe ser estable aunque cambie el orden de las propiedades'
);



includes(
  kitchenRoute,
  'buildKitchenChanges',
  'Cocina debe calcular las diferencias exactas de cada corrección'
);

includes(
  kitchenRoute,
  'antes,',
  'Cocina debe consultar la versión anterior del pedido'
);

includes(
  kitchenRoute,
  'despues',
  'Cocina debe consultar la versión nueva del pedido'
);

includes(
  kitchenClient,
  'Cambios pendientes para Cocina',
  'La interfaz debe mostrar los cambios pendientes de forma explícita'
);

includes(
  kitchenClient,
  'PREPARAR EXTRA',
  'La interfaz debe señalar cantidades aumentadas'
);

includes(
  kitchenClient,
  'NO PREPARAR',
  'La interfaz debe señalar productos retirados'
);



// DAILY_FOLIOS_AND_HIDE_READY_V1
const dailyFolios = read('middleware/folios-diarios.js');
includes(server, 'dailyOrderFolioMiddleware',
  'El servidor debe activar los folios diarios');
includes(dailyFolios, 'pedidos_folios_diarios',
  'Debe existir un contador de folios por fecha');
includes(dailyFolios, 'America/Mexico_City',
  'El reinicio diario debe usar Ciudad de México');
includes(kitchenRoute, ") <> 'Listo'",
  'Cocina no debe listar pedidos Listo');
includes(kitchenClient, "state === 'Listo'",
  'La tarjeta debe retirarse inmediatamente');

console.log(
  '✅ Pruebas de permisos, Cocina e idempotencia superadas.'
);
