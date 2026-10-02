// Logging estructurado en JSON (una línea por evento). Nunca loguear el contenido de las listas:
// pueden tener nombres de chicos, cursos o colegios. Sólo métricas y códigos.

function write(level, event, fields) {
  const line = { t: new Date().toISOString(), level, event, ...fields };
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + "\n");
}

const logger = {
  info: (event, fields = {}) => write("info", event, fields),
  warn: (event, fields = {}) => write("warn", event, fields),
  error: (event, fields = {}) => write("error", event, fields),
};

// Cronómetro por etapas: timer.stage("extract") ... timer.done() → { extract: 812, total: 1630 }
function stageTimer() {
  const start = process.hrtime.bigint();
  let last = start;
  const stages = {};
  const ms = (a, b) => Number((b - a) / 1000000n);
  return {
    stage(name) {
      const now = process.hrtime.bigint();
      stages[name] = (stages[name] || 0) + ms(last, now);
      last = now;
    },
    done() {
      return { ...stages, total: ms(start, process.hrtime.bigint()) };
    },
  };
}

if (process.env.NODE_ENV === "test" && !process.env.LOG_IN_TESTS) {
  logger.info = logger.warn = logger.error = () => {};
}

module.exports = { logger, stageTimer };
