// Configuración centralizada. Todo lo que cambia entre entornos sale de variables de entorno.
const path = require("path");

const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const list = (v, d) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : d);

const ROOT = path.resolve(__dirname, "..", "..");
const env = process.env;
// Secreto para hashear IPs en los contadores: estable entre reinicios (si no, cada reinicio "perdona" a todos).
const quotaSecret = env.QUOTA_SECRET || (env.ADMIN_TOKEN ? require("crypto").createHash("sha256").update("quota:" + env.ADMIN_TOKEN).digest("hex") : "");

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
    // Temporada alta: cuántas listas lee la IA a la vez; el resto espera en fila (y ve su lugar).
    maxConcurrency: num(process.env.AI_MAX_CONCURRENCY, 8),
    maxQueue: num(process.env.AI_MAX_QUEUE, 30),
    queueTimeoutMs: num(process.env.AI_QUEUE_TIMEOUT_MS, 60000),
    // Caché en memoria por contenido del documento: muchas familias suben la misma lista del colegio.
    cacheTtlHours: num(process.env.AI_CACHE_TTL_HOURS, 24),
    cacheMaxEntries: num(process.env.AI_CACHE_MAX, 300),
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
    // Sync automático desde la tienda dentro del servidor (horas). 0 = desactivado.
    syncHours: num(process.env.CATALOG_SYNC_HOURS, 6),
    // Al arrancar con un snapshot viejo, esperar un poco antes de sincronizar (que el servidor ya atienda).
    syncStartDelayMs: num(process.env.CATALOG_SYNC_START_DELAY_MS, 60 * 1000),
    // Un sync que trae menos de este % del catálogo actual se descarta (página caída, error de la tienda).
    minSyncRatio: num(process.env.CATALOG_MIN_SYNC_RATIO, 0.7),
  },

  http: {
    allowedOrigins: list(process.env.ALLOWED_ORIGINS, [
      "https://librerialerma.com.ar",
      "https://www.librerialerma.com.ar",
      "https://librerialerma.com",
      "https://www.librerialerma.com",
      "https://presupuestador-escolar.onrender.com",
    ]),
    matchRateLimitPerMin: num(process.env.MATCH_RATE_LIMIT_PER_MIN, 120),
    maxUploadBytes: num(process.env.MAX_UPLOAD_MB, 10) * 1024 * 1024,
    maxFiles: num(process.env.MAX_FILES, 5),
    maxPastedChars: num(process.env.MAX_PASTED_CHARS, 20000),
    // Tamaño total de un pedido con archivos: se rechaza antes de leerlo (protege la memoria del servidor).
    maxRequestBytes: num(process.env.MAX_REQUEST_MB, 25) * 1024 * 1024,
    // Pedidos con archivos procesándose a la vez (cada uno ocupa memoria hasta terminar).
    maxInflightUploads: num(process.env.MAX_INFLIGHT_UPLOADS, 20),
  },

  // Límites contra abusos (ver src/security/quota.js). Pensados para que una familia nunca los toque:
  // una conexión compartida (wifi de un colegio, datos móviles con IP compartida) puede tener varias familias.
  abuse: {
    // Saltos de proxy delante de la app (Cloudflare + Render = 2). Sólo se usa si no llega CF-Connecting-IP.
    trustProxyHops: num(env.TRUST_PROXY_HOPS, 2),
    // Presupuestos por IP
    budgetsPer10Min: num(env.RATE_LIMIT_PER_10MIN, 10),
    budgetsPerHour: num(env.RATE_LIMIT_PER_HOUR, 30),
    budgetsPerDay: num(env.RATE_LIMIT_PER_DAY, 80),
    // Horario nocturno (hora de Argentina): límite por hora más estricto.
    nightStartHour: num(env.NIGHT_START_HOUR, 0),
    nightEndHour: num(env.NIGHT_END_HOUR, 7),
    budgetsPerNightHour: num(env.RATE_LIMIT_NIGHT_PER_HOUR, 8),
    // Tope global de lecturas con IA (costo), sumando todas las IPs.
    aiGlobalPerHour: num(env.AI_GLOBAL_PER_HOUR, 300),
    aiGlobalPerDay: num(env.AI_GLOBAL_PER_DAY, 2000),
    // Otros endpoints
    sharesPer10Min: num(env.SHARES_PER_10MIN, 30),
    sharesPerDay: num(env.SHARES_PER_DAY, 150),
    pdfPer10Min: num(env.PDF_PER_10MIN, 20),
    pdfPerDay: num(env.PDF_PER_DAY, 150),
    eventsPerMin: num(env.EVENTS_PER_MIN, 60),
    adminPer10Min: num(env.ADMIN_PER_10MIN, 20),
    secret: quotaSecret,
    // Sólo para pruebas de carga locales. Nunca en producción (se avisa en el log al arrancar).
    disabled: env.RATE_LIMITS_DISABLED === "1",
  },

  data: {
    // Postgres administrado (Neon, Supabase, Render…). Sin DATABASE_URL se usa memoria: todo funciona, pero los
    // presupuestos guardados y las métricas se pierden al reiniciar (los links se arman igual, autocontenidos).
    databaseUrl: process.env.DATABASE_URL || "",
    // Algunos proveedores (pooler de Supabase) usan certificados que Node no reconoce.
    databaseSslNoVerify: process.env.DATABASE_SSL_NO_VERIFY === "1",
    // Días que dura el link de un presupuesto guardado.
    shareDays: num(process.env.BUDGET_SHARE_DAYS, 90),
    // Dónde se abre un presupuesto compartido: la página de la tienda (el snippet de Tiendanube le pasa el ?p= al
    // presupuestador), así la familia compra ahí mismo. Si se saca el snippet: SHARE_BASE_URL=https://presupuestador-escolar.onrender.com/presupuesto/
    shareBaseUrl: process.env.SHARE_BASE_URL || "https://www.librerialerma.com.ar/presupuesta-tu-lista-escolar/?p=",
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
