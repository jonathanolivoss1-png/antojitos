require('dotenv').config();

const express = require('express');
const pool = require("./db");
const pgPool = require("./postgres");
const path = require('path');
const session = require('express-session');
const initDatabase = require('./database/init');
const { maybeArchiveAndResetDailyOrders } = require('./database/init');
const authRoutes = require('./routes/auth');
const { router: pedidosRoutes } = require('./routes/pedidos');
const adminRoutes = require('./routes/admin');

const app = express();
app.get("/test-postgres", (req, res) => {
  res.json({
    mensaje: "La ruta test-postgres está funcionando",
  });
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const port = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

initDatabase();
maybeArchiveAndResetDailyOrders();
setInterval(() => {
    try {
        maybeArchiveAndResetDailyOrders();
    } catch (error) {
        console.warn('No se pudo verificar el reinicio diario automático', error);
    }
}, 60 * 1000);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

app.set('trust proxy', isProduction ? 1 : 0);

app.use(session({
    name: process.env.SESSION_NAME || 'anafres.sid',
    secret: process.env.SESSION_SECRET || 'cambia_esta_clave_en_produccion',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: isProduction,
        maxAge: 1000 * 60 * 60 * 12
    }
}));

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
app.get("/test-db", async (req, res) => {
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
    console.error("Error conectando a PostgreSQL:", error);

    res.status(500).json({
      conectado: false,
      mensaje: "No se pudo conectar a PostgreSQL",
      error: error.message,
    });
  }
});
//
const PORT = process.env.PORT || 3000;
//
app.get("/test-postgres", async (req, res) => {
  try {
    console.log("Tipo de pgPool.query:", typeof pgPool.query);

    if (typeof pgPool.query !== "function") {
      return res.status(500).json({
        conectado: false,
        mensaje: "pgPool no es una conexión PostgreSQL válida",
        tipoQuery: typeof pgPool.query,
      });
    }

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
      mensaje: "No se pudo conectar a PostgreSQL",
      error: error.message,
    });
  }
});
//
app.listen(PORT, () => {
  console.log(`Servidor iniciado en el puerto ${PORT}`);
});