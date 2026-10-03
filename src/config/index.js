// Configuración centralizada. Todo lo que cambia entre entornos sale de variables de entorno.
const path = require("path");

const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const list = (v, d) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : d);

const ROOT = path.resolve(__dirname, "..", "..");

module.exports = {
  root: ROOT,
  port: num(process.env.PORT || (process.argv.find((a) => a.startsWith("--port=")) || "").split("=")[1], 3001),
  env: process.env.NODE_ENV || "development",

  ai: {
    // Modelo principal y alternativo (si el principal falla por saturación o timeout).
    model: process.env.AI_MODEL || "claude-opus-5-5",
    fallbackModel: process.env.AI_FALLBACK_MODEL || "claude-sonnet-5-5",
    // La extracción de una lista es una tarea simple: esfuerzo bajo = menos latencia y costo.
    effort: process.env.AI_EFFORT || "low",
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 60000),
    maxTokens: num(process.env.AI_MAX_TOKENS, 16000),
    // Desempate por IA de ítems con confianza media (0 = desactivado).
    rerankMaxItems: num(process.env.AI_RERANK_MAX_ITEMS, 15),
    enabled: process.env.AI_DISABLED !== "1",
  },

  catalog: {
    // Snapshot normalizado que produce scripts/sync-catalog.js. Si no existe se usa catalog.json (legacy).
    snapshotPath: process.env.CATALOG_PATH || path.join(ROOT, "data", "catalog.json"),
    legacyPath: path.join(ROOT, "catalog.json"),
    storeBaseUrl: process.env.STORE_BASE_URL || "https://www.librerialerma.com.ar",
    tiendanubeStoreId: process.env.TIENDANUBE_STORE_ID || "854738",
    tiendanubeToken: process.env.TIENDANUBE_ACCESS_TOKEN || "",
    // Precio mínimo para considerar un producto presupuestable (hay productos cargados a $1).
    minValidPrice: num(process.env.CATALOG_MIN_PRICE, 2),
    // Recarga del snapshot en caliente (ms). 0 = no recargar.
    reloadIntervalMs: num(process.env.CATALOG_RELOAD_MS, 10 * 60 * 1000),
  },

  http: {
    allowedOrigins: list(process.env.ALLOWED_ORIGINS, [
      "https://librerialerma.com.ar",
      "https://www.librerialerma.com.ar",
      "https://presupuestador-escolar.onrender.com",
    ]),
    rateLimitPer10Min: num(process.env.RATE_LIMIT_PER_10MIN, 15),
    matchRateLimitPerMin: num(process.env.MATCH_RATE_LIMIT_PER_MIN, 120),
    maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 10) * 1024 * 1024,
    maxFiles: num(process.env.MAX_FILES, 5),
    maxPastedChars: num(process.env.MAX_PASTED_CHARS, 20000),
  },

  data: {
    // Postgres administrado (Neon, Supabase, Render…). Sin DATABASE_URL se usa memoria: todo funciona, pero los
    // presupuestos guardados y las métricas se pierden al reiniciar (los links se arman igual, autocontenidos).
    databaseUrl: process.env.DATABASE_URL || "",
    // Algunos proveedores (pooler de Supabase) usan certificados que Node no reconoce.
    databaseSslNoVerify: process.env.DATABASE_SSL_NO_VERIFY === "1",
    // Días que dura el link de un presupuesto guardado.
    shareDays: num(process.env.BUDGET_SHARE_DAYS, 90),
    // Dónde se abre un presupuesto compartido. Con el snippet de Tiendanube instalado conviene la página de la
    // tienda (https://www.librerialerma.com.ar/presupuesta-tu-lista-escolar/?p=), así se puede comprar ahí mismo.
    shareBaseUrl: process.env.SHARE_BASE_URL || "https://presupuestador-escolar.onrender.com/presupuesto/",
    // Panel /admin. Sin token el panel está desactivado.
    adminToken: process.env.ADMIN_TOKEN || "",
  },

  store: {
    name: "Librería Lerma",
    address: process.env.STORE_ADDRESS || "Belgrano 635, Salta",
    phone: process.env.STORE_PHONE || "0387-4314736",
    whatsapp: process.env.STORE_WHATSAPP || "5493874576331",
    website: "librerialerma.com.ar",
    budgetValidityDays: num(process.env.BUDGET_VALIDITY_DAYS, 7),
  },
};
