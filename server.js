// Punto de entrada. La lógica vive en src/ (ver docs/ARQUITECTURA.md).
const config = require("./src/config");
const { store } = require("./src/catalog/catalogStore");
const { createApp } = require("./src/app");
const { logger } = require("./src/observability/logger");

store.loadFromDisk();
store.startAutoReload(config.catalog.reloadIntervalMs);

createApp().listen(config.port, () => {
  logger.info("server_started", { port: config.port, model: config.ai.model, fallbackModel: config.ai.fallbackModel, ai: Boolean(process.env.ANTHROPIC_API_KEY) });
});
