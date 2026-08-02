const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("No se encontró DATABASE_URL");
}

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : {
        rejectUnauthorized: false,
      },
});

module.exports = pgPool;