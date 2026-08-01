const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../database/db');

const router = express.Router();

function sanitizeText(value, maxLength = 120) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

router.post('/login', async (req, res) => {
  try {
    const usuario = sanitizeText(req.body?.usuario, 60);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!usuario || !password) {
      return res.status(400).json({ ok: false, message: 'Usuario y contrasena son obligatorios' });
    }

    const user = db.prepare('SELECT id, usuario, password FROM usuarios WHERE usuario = ?').get(usuario);
    if (!user) {
      return res.status(401).json({ ok: false, message: 'Credenciales invalidas' });
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return res.status(401).json({ ok: false, message: 'Credenciales invalidas' });
    }

    req.session.regenerate(error => {
      if (error) {
        return res.status(500).json({ ok: false, message: 'No se pudo iniciar sesion' });
      }

      req.session.user = {
        id: user.id,
        usuario: user.usuario
      };

      return res.json({ ok: true, user: req.session.user });
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: 'Error interno de autenticacion' });
  }
});

router.post('/logout', (req, res) => {
  if (!req.session) {
    return res.json({ ok: true });
  }

  req.session.destroy(() => {
    res.clearCookie(process.env.SESSION_NAME || 'anafres.sid');
    return res.json({ ok: true });
  });
});

router.get('/session', (req, res) => {
  const user = req.session?.user || null;
  return res.json({ ok: true, authenticated: Boolean(user), user });
});

module.exports = router;
