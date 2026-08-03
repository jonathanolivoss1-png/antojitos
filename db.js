const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("No se encontró DATABASE_URL");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : {
        rejectUnauthorized: false,
      },
});

pool.on("error", (error) => {
  console.error("Error inesperado de PostgreSQL:", error);
});

module.exports = pool;