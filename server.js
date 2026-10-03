// Punto de entrada. La lógica vive en src/ (ver docs/ARQUITECTURA.md).
const config = require("./src/config");
const { store } = require("./src/catalog/catalogStore");
const { createApp } = require("./src/app");
const { initStorage, getStorage } = require("./src/storage");
const { logger } = require("./src/observability/logger");

store.loadFromDisk();
store.startAutoReload(config.catalog.reloadIntervalMs);

// La base de datos es opcional: si no responde se arranca igual con memoria.
initStorage().finally(() => {
  createApp().listen(config.port, () => {
    logger.info("server_started", { port: config.port, model: config.ai.model, fallbackModel: config.ai.fallbackModel, ai: Boolean(process.env.ANTHROPIC_API_KEY), storage: getStorage().kind });
  });
});
