require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const initDatabase = require('./database/init');
const { maybeArchiveAndResetDailyOrders } = require('./database/init');
const authRoutes = require('./routes/auth');
const { router: pedidosRoutes } = require('./routes/pedidos');
const adminRoutes = require('./routes/admin');

const app = express();
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

app.get('/test-db', async (req, res) => {
    try {
        res.json({
            mensaje: 'Conexión a SQLite exitosa',
            fecha: new Date().toISOString()
        });

    } catch (error) {
        res.status(500).json({
            mensaje: 'Error al conectar con SQLite',
            error: error.message
        });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ ok: false, message: 'Error interno del servidor' });
});

app.listen(port, () => {
    console.log(`Servidor corriendo en http://localhost:${port}`);
});