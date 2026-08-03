require('dotenv').config();
console.log("=== DIAGNÓSTICO DE RENDER ===");
console.log("Ejecutándose en Render:", process.env.RENDER === "true");
console.log(
  "DATABASE_URL detectada:",
  Boolean(process.env.DATABASE_URL)
);
console.log(
  "Commit desplegado:",
  process.env.RENDER_GIT_COMMIT || "local"
);
const express = require('express');
const pool = require("./db");
const pgPool = require("./postgres");
const path = require('path');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const initDatabase = require('./database/init');
const authRoutes = require('./routes/auth');
const { router: pedidosRoutes } = require('./routes/pedidos');

const {
  maybeArchiveAndResetDailyOrders
} = require('./database/init');
const adminRoutes = require('./routes/admin');


const app = express();
app.get("/test-postgres", (req, res) => {
  res.json({
    mensaje: "La ruta test-postgres está funcionando",
  });
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

initDatabase();

try {
  maybeArchiveAndResetDailyOrders();
} catch (error) {
  console.error('Error archivando pedidos:', error);
}
setInterval(() => {
  try {
    maybeArchiveAndResetDailyOrders();
  } catch (error) {
    console.error('Error archivando pedidos:', error);
  }
}, 60 * 1000);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

if (!process.env.SESSION_SECRET) {
  throw new Error('Falta la variable SESSION_SECRET');
}

app.set('trust proxy', 1);

app.use(
  session({
    store: new PgSession({
      pool: pgPool,
      tableName: 'user_sessions',
      createTableIfMissing: true
    }),

    name: process.env.SESSION_NAME || 'anafres.sid',
    secret: process.env.SESSION_SECRET,

    resave: false,
    saveUninitialized: false,

    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    }
  })
);

app.use('/api', authRoutes);
app.use('/api/pedidos', pedidosRoutes);
app.use('/api/admin', adminRoutes);

app.use(express.static(path.join(__dirname, 'public')));



app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Error interno del servidor' });
});
//
app.get("/test-postgres", async (req, res) => {
  if (!pgPool) {
    return res.status(500).json({
      conectado: false,
      mensaje: "Render no proporcionó DATABASE_URL al servidor",
      ejecutandoseEnRender: process.env.RENDER === "true",
      databaseUrlDetectada: Boolean(process.env.DATABASE_URL),
    });
  }

  try {
    const resultado = await pgPool.query(`
      SELECT
        NOW() AS fecha,
        current_database() AS base_de_datos,
        current_user AS usuario
    `);

    res.json({
      conectado: true,
      mensaje: "Conexión a PostgreSQL exitosa",
      datos: resultado.rows[0],
    });
  } catch (error) {
    console.error("Error PostgreSQL:", error);

    res.status(500).json({
      conectado: false,
      mensaje: "DATABASE_URL existe, pero PostgreSQL rechazó la conexión",
      error: error.message,
    });
  }
});
//
app.listen(PORT, () => {
  console.log(`Servidor iniciado en el puerto ${PORT}`);
});