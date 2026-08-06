// KITCHEN_APP_IDEMPOTENCY_SECURITY_V1
require('dotenv').config();

console.log('=== DIAGNÓSTICO DE RENDER ===');
console.log('Ejecutándose en Render:', process.env.RENDER === 'true');
console.log('DATABASE_URL detectada:', Boolean(process.env.DATABASE_URL));
console.log('Commit desplegado:', process.env.RENDER_GIT_COMMIT || 'local');

const express = require('express');
const path = require('path');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const pgPool = require('./postgres');
const initDatabase = require('./database/init');
const authRoutes = require('./routes/auth');
const {
  router: pedidosRoutes,
  maybeArchiveAndResetDailyOrders
} = require('./routes/pedidos');
const adminRoutes = require('./routes/admin');
const businessProtectionRoutes = require('./routes/proteccion-negocio');
const meserosRoutes = require('./routes/meseros');
const personalCorrectionsRoutes = require('./routes/correcciones-personal');
const kitchenChangesRoutes = require('./routes/cambios-cocina');

const { createOrderIdempotency } = require('./middleware/idempotencia-pedidos');
const { router: cocinaRoutes } = require('./routes/cocina');

const { dailyOrderFolioMiddleware } = require('./middleware/folios-diarios');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
app.disable('x-powered-by');

// KITCHEN_SECURITY_HEADERS_V1
app.use((req, res, next) => {
  res.setHeader(
    'X-Content-Type-Options',
    'nosniff'
  );
  res.setHeader(
    'X-Frame-Options',
    'SAMEORIGIN'
  );
  res.setHeader(
    'Referrer-Policy',
    'same-origin'
  );
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );
  next();
});



app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

const sessionSecret =
  process.env.SESSION_SECRET ||
  (isProduction ? null : 'dev-session-secret-change-me');

if (!sessionSecret) {
  throw new Error('Falta la variable SESSION_SECRET en producción');
}

const sessionOptions = {
  name: process.env.SESSION_NAME || 'anafres.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
};

if (pgPool) {
  sessionOptions.store = new PgSession({
    pool: pgPool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  });
  console.log('Sesiones configuradas con PostgreSQL');
} else {
  console.warn(
    'PostgreSQL no está disponible; usando MemoryStore solo para desarrollo local.'
  );
}

app.use(session(sessionOptions));

// DAILY_FOLIOS_AND_HIDE_READY_V1
app.use(dailyOrderFolioMiddleware);
// ORDER_IDEMPOTENCY_V1
const publicOrderIdempotency =
  createOrderIdempotency({
    scope: 'public-orders',
    principal: req =>
      req.body?.clienteToken ||
      req.body?.clientToken ||
      req.ip ||
      'public'
  });

const personalOrderIdempotency =
  createOrderIdempotency({
    scope: 'personal-orders',
    principal: req =>
      req.session?.mesero?.id ||
      req.ip ||
      'personal'
  });



app.get('/test-postgres', async (req, res) => {
  if (!pgPool) {
    return res.status(503).json({
      conectado: false,
      mensaje: 'PostgreSQL no está disponible; el servidor usa el respaldo local.',
      ejecutandoseEnRender: process.env.RENDER === 'true',
      databaseUrlDetectada: Boolean(process.env.DATABASE_URL)
    });
  }

  try {
    const result = await pgPool.query(`
      SELECT
        NOW() AS fecha,
        current_database() AS base_de_datos,
        current_user AS usuario
    `);

    return res.json({
      conectado: true,
      mensaje: 'Conexión a PostgreSQL exitosa',
      datos: result.rows[0]
    });
  } catch (error) {
    console.error('Error PostgreSQL:', error);

    return res.status(500).json({
      conectado: false,
      mensaje: 'DATABASE_URL existe, pero PostgreSQL rechazó la conexión',
      error: error.message
    });
  }
});

app.use('/api', authRoutes);
app.use('/api/pedidos', publicOrderIdempotency);
app.use('/api/pedidos', pedidosRoutes);
app.use('/api/admin', businessProtectionRoutes);
app.use('/api/admin', kitchenChangesRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/meseros/orders', personalOrderIdempotency);
app.use('/api/meseros', meserosRoutes);
app.use('/api/cocina', cocinaRoutes);

app.use('/api/meseros', personalCorrectionsRoutes);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, req, res, next) => {
  console.error('Error interno del servidor:', error);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    ok: false,
    message: 'Error interno del servidor'
  });
});

async function startServer() {
  if (isProduction && !pgPool) {
    throw new Error('DATABASE_URL es obligatoria en producción');
  }

  if (
    isProduction &&
    !process.env.ADMIN_PASSWORD &&
    !process.env.ADMIN_PASS
  ) {
    throw new Error('Falta ADMIN_PASSWORD en producción');
  }

  await initDatabase();
  console.log('Base de datos inicializada correctamente');

  await maybeArchiveAndResetDailyOrders();

  const archiveTimer = setInterval(() => {
    void maybeArchiveAndResetDailyOrders().catch(error => {
      console.error('Error archivando pedidos:', error);
    });
  }, 60 * 1000);

  archiveTimer.unref?.();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor iniciado en el puerto ${PORT}`);
  });
}

startServer().catch(error => {
  console.error('No se pudo iniciar el servidor:', error);
  process.exit(1);
});
