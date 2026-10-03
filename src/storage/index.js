// Punto único de acceso al almacenamiento. Postgres si hay DATABASE_URL; si no (o si la base no responde al
// arrancar), memoria: el presupuestador nunca deja de funcionar por la base de datos.
const config = require("../config");
const { createMemoryStorage } = require("./memory");
const { createPostgresStorage } = require("./postgres");
const { logger } = require("../observability/logger");

let current = createMemoryStorage();

async function initStorage() {
  if (!config.data.databaseUrl) {
    logger.warn("storage_memory", { reason: "sin DATABASE_URL: presupuestos guardados y métricas se pierden al reiniciar" });
    return current;
  }
  const pg = createPostgresStorage({ connectionString: config.data.databaseUrl, sslNoVerify: config.data.databaseSslNoVerify });
  try {
    await pg.init();
    current = pg;
    logger.info("storage_postgres");
  } catch (e) {
    logger.error("storage_init_failed", { message: e.message });
    pg.close().catch(() => {});
  }
  return current;
}

const getStorage = () => current;
const setStorage = (s) => (current = s); // tests

module.exports = { initStorage, getStorage, setStorage };
