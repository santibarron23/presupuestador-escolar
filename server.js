// Punto de entrada. La lógica vive en src/ (ver docs/ARQUITECTURA.md).
const config = require("./src/config");
const { store } = require("./src/catalog/catalogStore");
const { createApp } = require("./src/app");
const { initStorage, getStorage } = require("./src/storage");
const { startScheduledSync } = require("./src/catalog/syncService");
const { logger } = require("./src/observability/logger");

store.loadFromDisk();
store.startAutoReload(config.catalog.reloadIntervalMs);
// Precios y stock al día sin redeploy (cada CATALOG_SYNC_HOURS; enseguida si el snapshot es viejo).
startScheduledSync(store);

// La base de datos es opcional: si no responde se arranca igual con memoria.
initStorage().finally(() => {
  const server = createApp().listen(config.port, () => {
    logger.info("server_started", { port: config.port, model: config.ai.model, fallbackModel: config.ai.fallbackModel, ai: Boolean(process.env.ANTHROPIC_API_KEY), storage: getStorage().kind });
  });
  // Conexiones lentas a propósito (slowloris) no pueden ocupar el servidor indefinidamente.
  // Un presupuesto con fila de IA tarda como mucho ~2 min (60 s de fila + lectura + reintento).
  server.headersTimeout = 20 * 1000;
  server.requestTimeout = 3 * 60 * 1000;
  server.keepAliveTimeout = 65 * 1000; // > timeout del balanceador de Render, evita cortes intermitentes
});
