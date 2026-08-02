const { Pool } = require("pg");

const databaseUrl = process.env.DATABASE_URL;

let pgPool = null;

if (!databaseUrl) {
  console.error(
    "POSTGRESQL NO INICIADO: DATABASE_URL no está disponible"
  );
} else {
  pgPool = new Pool({
    connectionString: databaseUrl,
    ssl:
      databaseUrl.includes("localhost") ||
      databaseUrl.includes("127.0.0.1")
        ? false
        : {
            rejectUnauthorized: false,
          },
  });

  pgPool.on("error", (error) => {
    console.error("Error inesperado de PostgreSQL:", error);
  });

  console.log("Pool de PostgreSQL creado correctamente");
}

module.exports = pgPool;