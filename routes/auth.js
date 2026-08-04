const express = require('express');
const bcrypt = require('bcryptjs');

const pgPool = require('../postgres');
const db = require('../database/db');

const router = express.Router();

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const CONFIGURED_ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ||
  process.env.ADMIN_PASS ||
  '';
const RESET_ADMIN_PASSWORD =
  process.env.RESET_ADMIN_PASSWORD_ON_START === 'true';

const DEVELOPMENT_ADMIN_PASSWORD = 'dev-only-change-me-123!';
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;

const loginAttempts = new Map();
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  'invalid-password-placeholder',
  10
);

function sanitizeText(value, maxLength = 120) {
  if (typeof value !== 'string') return '';

  return value
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, maxLength);
}

function getLoginKey(req, usuario) {
  return [
    req.ip || 'unknown',
    String(usuario || '').trim().toLowerCase()
  ].join(':');
}

function getAttemptState(key) {
  const now = Date.now();
  const state = loginAttempts.get(key);

  if (!state) {
    return {
      count: 0,
      firstAttemptAt: now,
      lockedUntil: 0
    };
  }

  if (state.lockedUntil > now) {
    return state;
  }

  if (now - state.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return {
      count: 0,
      firstAttemptAt: now,
      lockedUntil: 0
    };
  }

  return state;
}

function recordFailedAttempt(key) {
  const now = Date.now();
  const state = getAttemptState(key);
  state.count += 1;

  if (state.count >= MAX_FAILED_ATTEMPTS) {
    state.lockedUntil = now + LOGIN_LOCK_MS;
  }

  loginAttempts.set(key, state);
  return state;
}

function clearFailedAttempts(key) {
  loginAttempts.delete(key);
}

function getInitialAdminPassword() {
  if (CONFIGURED_ADMIN_PASSWORD) {
    return CONFIGURED_ADMIN_PASSWORD;
  }

  if (IS_PRODUCTION) {
    throw new Error('Falta ADMIN_PASSWORD en producción');
  }

  console.warn(
    'ADMIN_PASSWORD no está configurada. En desarrollo se usará una contraseña temporal.'
  );

  return DEVELOPMENT_ADMIN_PASSWORD;
}

async function initializeUsersTable() {
  const adminUser = 'admin';

  if (pgPool) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id BIGSERIAL PRIMARY KEY,
        usuario VARCHAR(60) NOT NULL UNIQUE,
        password TEXT NOT NULL
      )
    `);
  } else {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL
      )
    `).run();
  }

  const result = pgPool
    ? await pgPool.query(
        `
          SELECT id, usuario, password
          FROM usuarios
          WHERE usuario = $1
          LIMIT 1
        `,
        [adminUser]
      )
    : {
        rows: [
          db.prepare(`
            SELECT id, usuario, password
            FROM usuarios
            WHERE usuario = ?
            LIMIT 1
          `).get(adminUser)
        ]
      };

  const existingUser = result.rows[0];

  if (!existingUser) {
    const initialPassword = getInitialAdminPassword();
    const passwordHash = await bcrypt.hash(initialPassword, 10);

    if (pgPool) {
      await pgPool.query(
        `
          INSERT INTO usuarios (usuario, password)
          VALUES ($1, $2)
        `,
        [adminUser, passwordHash]
      );
    } else {
      db.prepare(`
        INSERT INTO usuarios (usuario, password)
        VALUES (?, ?)
      `).run(adminUser, passwordHash);
    }

    console.log(
      `Usuario admin creado en ${pgPool ? 'PostgreSQL' : 'SQLite'}.`
    );
    return;
  }

  /*
   * No se reemplaza la contraseña en cada reinicio.
   * Para restablecerla deliberadamente:
   * RESET_ADMIN_PASSWORD_ON_START=true
   */
  if (RESET_ADMIN_PASSWORD) {
    if (!CONFIGURED_ADMIN_PASSWORD) {
      throw new Error(
        'RESET_ADMIN_PASSWORD_ON_START requiere ADMIN_PASSWORD'
      );
    }

    const passwordMatches = await bcrypt.compare(
      CONFIGURED_ADMIN_PASSWORD,
      existingUser.password
    );

    if (!passwordMatches) {
      const passwordHash = await bcrypt.hash(
        CONFIGURED_ADMIN_PASSWORD,
        10
      );

      if (pgPool) {
        await pgPool.query(
          `
            UPDATE usuarios
            SET password = $1
            WHERE usuario = $2
          `,
          [passwordHash, adminUser]
        );
      } else {
        db.prepare(`
          UPDATE usuarios
          SET password = ?
          WHERE usuario = ?
        `).run(passwordHash, adminUser);
      }

      console.warn(
        'Contraseña de admin restablecida mediante RESET_ADMIN_PASSWORD_ON_START.'
      );
    }
  }
}

let initializationError = null;

const usersReady = initializeUsersTable().catch(error => {
  initializationError = error;
  console.error('Error inicializando usuarios:', error.message);
});

router.post('/login', async (req, res) => {
  try {
    await usersReady;

    if (initializationError) {
      throw initializationError;
    }

    const usuario = sanitizeText(req.body?.usuario, 60);
    const password =
      typeof req.body?.password === 'string'
        ? req.body.password
        : '';

    if (!usuario || !password) {
      return res.status(400).json({
        ok: false,
        message: 'Usuario y contraseña son obligatorios'
      });
    }

    const loginKey = getLoginKey(req, usuario);
    const attemptState = getAttemptState(loginKey);

    if (attemptState.lockedUntil > Date.now()) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((attemptState.lockedUntil - Date.now()) / 1000)
      );

      res.setHeader('Retry-After', String(retryAfterSeconds));

      return res.status(429).json({
        ok: false,
        message: 'Demasiados intentos. Intenta nuevamente más tarde.'
      });
    }

    const result = pgPool
      ? await pgPool.query(
          `
            SELECT id, usuario, password
            FROM usuarios
            WHERE usuario = $1
            LIMIT 1
          `,
          [usuario]
        )
      : {
          rows: [
            db.prepare(`
              SELECT id, usuario, password
              FROM usuarios
              WHERE usuario = ?
              LIMIT 1
            `).get(usuario)
          ]
        };

    const user = result.rows[0];
    const hashToCompare = user?.password || DUMMY_PASSWORD_HASH;
    const isValid = await bcrypt.compare(password, hashToCompare);

    if (!user || !isValid) {
      const failedState = recordFailedAttempt(loginKey);

      if (failedState.lockedUntil > Date.now()) {
        res.setHeader(
          'Retry-After',
          String(Math.ceil(LOGIN_LOCK_MS / 1000))
        );

        return res.status(429).json({
          ok: false,
          message: 'Demasiados intentos. Intenta nuevamente más tarde.'
        });
      }

      return res.status(401).json({
        ok: false,
        message: 'Credenciales inválidas'
      });
    }

    clearFailedAttempts(loginKey);

    req.session.regenerate(error => {
      if (error) {
        console.error('Error regenerando sesión:', error);

        return res.status(500).json({
          ok: false,
          message: 'No se pudo iniciar sesión'
        });
      }

      req.session.user = {
        id: user.id,
        usuario: user.usuario
      };

      return res.json({
        ok: true,
        user: req.session.user
      });
    });
  } catch (error) {
    console.error('Error interno de autenticación:', error);

    return res.status(500).json({
      ok: false,
      message: 'Error interno de autenticación'
    });
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

  return res.json({
    ok: true,
    authenticated: Boolean(user),
    user
  });
});

const cleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const [key, state] of loginAttempts.entries()) {
    const expiredLock =
      state.lockedUntil && state.lockedUntil <= now;
    const expiredWindow =
      now - state.firstAttemptAt >
      LOGIN_WINDOW_MS + LOGIN_LOCK_MS;

    if (expiredLock || expiredWindow) {
      loginAttempts.delete(key);
    }
  }
}, 10 * 60 * 1000);

cleanupTimer.unref?.();

module.exports = router;
