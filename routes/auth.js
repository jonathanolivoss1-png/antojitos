const express = require("express");
const bcrypt = require("bcryptjs");
const pgPool = require("../postgres");
const db = require("../database/db");

const router = express.Router();
const DEFAULT_ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ||
  process.env.ADMIN_PASS ||
  "123456";

function sanitizeText(value, maxLength = 120) {
  if (typeof value !== "string") return "";

  return value
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

/*
 * Crea la tabla de usuarios y verifica que exista el usuario administrador.
 */
async function initializeUsersTable() {
  const adminUser = "admin";
  const adminPassword = DEFAULT_ADMIN_PASSWORD;

  if (!pgPool) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        usuario TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL
      )
    `).run();
  } else {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id BIGSERIAL PRIMARY KEY,
        usuario VARCHAR(60) NOT NULL UNIQUE,
        password TEXT NOT NULL
      )
    `);
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
    : { rows: [db.prepare('SELECT id, usuario, password FROM usuarios WHERE usuario = ?').get(adminUser)] };

  const existingUser = result.rows[0];

  if (!existingUser) {
    const passwordHash = await bcrypt.hash(adminPassword, 10);

    if (pgPool) {
      await pgPool.query(
        `
          INSERT INTO usuarios (usuario, password)
          VALUES ($1, $2)
        `,
        [adminUser, passwordHash]
      );
    } else {
      db.prepare(
        `INSERT INTO usuarios (usuario, password) VALUES (?, ?)`
      ).run(adminUser, passwordHash);
    }

    console.log(
      `Usuario admin creado en ${pgPool ? 'PostgreSQL' : 'SQLite'}.`
    );

    return;
  }

  const shouldResetPassword =
    process.env.RESET_ADMIN_PASSWORD_ON_START === "true";

  if (shouldResetPassword) {
    const passwordMatches = await bcrypt.compare(
      adminPassword,
      existingUser.password
    );

    if (!passwordMatches) {
      const passwordHash = await bcrypt.hash(adminPassword, 10);
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
        db.prepare(
          `UPDATE usuarios SET password = ? WHERE usuario = ?`
        ).run(passwordHash, adminUser);
      }

      console.log(
        `Contraseña de admin restablecida en ${pgPool ? 'PostgreSQL' : 'SQLite'}.`
      );
    }
  }
}

let initializationError = null;

const usersReady = initializeUsersTable().catch(
  (error) => {
    initializationError = error;

    console.error(
      "Error inicializando usuarios en PostgreSQL:",
      error.message
    );
  }
);

router.post("/login", async (req, res) => {
  try {
    await usersReady;

    if (initializationError) {
      throw initializationError;
    }

    const usuario = sanitizeText(
      req.body?.usuario,
      60
    );

    const password =
      typeof req.body?.password === "string"
        ? req.body.password
        : "";

    if (!usuario || !password) {
      return res.status(400).json({
        ok: false,
        message:
          "Usuario y contraseña son obligatorios",
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
      : { rows: [db.prepare(
          `SELECT id, usuario, password FROM usuarios WHERE usuario = ?`
        ).get(usuario)] };

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({
        ok: false,
        message: "Credenciales inválidas",
      });
    }

    const isValid = await bcrypt.compare(
      password,
      user.password
    );

    if (!isValid) {
      return res.status(401).json({
        ok: false,
        message: "Credenciales inválidas",
      });
    }

    req.session.regenerate((error) => {
      if (error) {
        console.error(
          "Error regenerando sesión:",
          error
        );

        return res.status(500).json({
          ok: false,
          message: "No se pudo iniciar sesión",
        });
      }

      req.session.user = {
        id: user.id,
        usuario: user.usuario,
      };

      return res.json({
        ok: true,
        user: req.session.user,
      });
    });
  } catch (error) {
    console.error(
      "Error interno de autenticación:",
      error
    );

    return res.status(500).json({
      ok: false,
      message:
        "Error interno de autenticación",
    });
  }
});

router.post("/logout", (req, res) => {
  if (!req.session) {
    return res.json({ ok: true });
  }

  req.session.destroy(() => {
    res.clearCookie(
      process.env.SESSION_NAME ||
        "anafres.sid"
    );

    return res.json({ ok: true });
  });
});

router.get("/session", (req, res) => {
  const user = req.session?.user || null;

  return res.json({
    ok: true,
    authenticated: Boolean(user),
    user,
  });
});

module.exports = router;