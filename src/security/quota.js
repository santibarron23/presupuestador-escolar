// Límites de uso contra abusos, por IP y globales, en varias ventanas de tiempo (10 min, hora, día) y con un
// límite más estricto de noche (horario en que las familias casi no usan el presupuestador y los bots sí).
//
// Los contadores viven en la base (sobreviven a los reinicios de Render). Si la base falla, se cuenta en
// memoria: nunca se deja a una familia sin presupuesto por un problema de la base, pero tampoco se abre la puerta.
// Privacidad: la IP nunca se guarda; la clave es un HMAC de la IP con un secreto del servidor.
const crypto = require("crypto");
const config = require("../config");
const { getStorage } = require("../storage");
const { createMemoryStorage } = require("../storage/memory");
const { clientIp } = require("./clientIp");
const { logger } = require("../observability/logger");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const AR_OFFSET = 3 * HOUR; // Argentina: UTC-3, sin horario de verano

const fallback = createMemoryStorage();
const secret = config.abuse.secret || crypto.randomBytes(32).toString("hex");

const hashIp = (ip) => crypto.createHmac("sha256", secret).update(String(ip)).digest("hex").slice(0, 24);

// Hora de Argentina (0–23).
const arHour = (now) => new Date(now - AR_OFFSET).getUTCHours();
function isNight(now = Date.now()) {
  const { nightStartHour: s, nightEndHour: e } = config.abuse;
  const h = arHour(now);
  return s <= e ? h >= s && h < e : h >= s || h < e;
}

// Las ventanas diarias arrancan a la medianoche de Argentina; las demás, alineadas al reloj.
function windowStart(windowMs, now) {
  const shift = windowMs === DAY ? AR_OFFSET : 0;
  return new Date(Math.floor((now - shift) / windowMs) * windowMs + shift);
}

async function increment(entries) {
  try {
    return await getStorage().incrementCounters(entries);
  } catch (e) {
    logger.warn("quota_storage_failed", { message: e.message });
    return fallback.incrementCounters(entries);
  }
}

// rules: [{ id, windowMs, limit, when?(now) }]. Cuenta el intento en todas las ventanas que aplican y devuelve
// la primera regla superada (o null). Un intento rechazado también cuenta: insistir no acorta la espera.
async function consume(subject, rules, now = Date.now()) {
  const active = rules.filter((r) => r.limit > 0 && (!r.when || r.when(now)));
  if (!active.length) return null;
  const entries = active.map((r) => ({ key: `${r.id}:${subject}`, windowStart: windowStart(r.windowMs, now), windowMs: r.windowMs }));
  const hits = await increment(entries);
  for (let i = 0; i < active.length; i++) {
    if (hits[i] > active[i].limit) {
      const retryAfterSec = Math.max(1, Math.ceil((entries[i].windowStart.getTime() + active[i].windowMs - now) / 1000));
      return { rule: active[i], hits: hits[i], retryAfterSec };
    }
  }
  return null;
}

// ── Reglas ─────────────────────────────────────────────────────────
const a = () => config.abuse;
const RULES = {
  // Presupuestos (leen la lista, con IA): lo más caro.
  budget: () => [
    { id: "budget_10m", windowMs: 10 * MIN, limit: a().budgetsPer10Min },
    { id: "budget_1h", windowMs: HOUR, limit: a().budgetsPerHour },
    { id: "budget_1d", windowMs: DAY, limit: a().budgetsPerDay },
    { id: "budget_night", windowMs: HOUR, limit: a().budgetsPerNightHour, when: isNight },
  ],
  share: () => [
    { id: "share_10m", windowMs: 10 * MIN, limit: a().sharesPer10Min },
    { id: "share_1d", windowMs: DAY, limit: a().sharesPerDay },
  ],
  pdf: () => [
    { id: "pdf_10m", windowMs: 10 * MIN, limit: a().pdfPer10Min },
    { id: "pdf_1d", windowMs: DAY, limit: a().pdfPerDay },
  ],
};

// Mensajes para la familia según qué límite se superó.
function messageFor(ruleId, retryAfterSec) {
  const mins = Math.max(1, Math.round(retryAfterSec / 60));
  const wait = mins >= 60 ? `${Math.round(mins / 60)} h` : `${mins} min`;
  const wa = ` Si lo necesitás ya, escribinos por WhatsApp al ${config.store.whatsapp.replace(/^549/, "")}.`;
  if (ruleId.endsWith("_1d")) return "Llegaste al máximo de consultas por hoy desde esta conexión. Probá de nuevo mañana." + wa;
  if (ruleId.endsWith("_night")) return `De noche limitamos las consultas para evitar abusos. Probá de nuevo en ${wait}.` + wa;
  return `Hiciste muchas consultas seguidas. Probá de nuevo en ${wait}.`;
}

// Middleware: corta con 429 antes de leer archivos o gastar IA.
function quotaMiddleware(scope, { onBlocked } = {}) {
  return async (req, res, next) => {
    if (a().disabled) return next();
    try {
      const over = await consume(hashIp(clientIp(req)), RULES[scope]());
      if (!over) return next();
      res.setHeader("Retry-After", String(over.retryAfterSec));
      logger.warn("quota_blocked", { scope, rule: over.rule.id, hits: over.hits, path: req.path, id: req.id });
      if (onBlocked) onBlocked(over.rule.id);
      return res.status(429).json({ error: messageFor(over.rule.id, over.retryAfterSec), code: "rate_limited", retryAfter: over.retryAfterSec });
    } catch (e) {
      // Un error del contador no deja sin servicio.
      logger.error("quota_failed", { message: e.message });
      return next();
    }
  };
}

// Tope global de lecturas con IA (costo): protege aunque el ataque venga de muchas IPs.
// Se consume sólo cuando de verdad se llama a la IA (una lista ya leída, desde la caché, no cuenta).
async function consumeGlobalAi(now = Date.now()) {
  if (a().disabled) return null;
  const over = await consume("global", [
    { id: "ai_global_1h", windowMs: HOUR, limit: a().aiGlobalPerHour },
    { id: "ai_global_1d", windowMs: DAY, limit: a().aiGlobalPerDay },
  ], now);
  if (over) return over;
  // Tope de tokens del día (el costo real): se lee el acumulado sin sumar.
  if (a().aiTokensPerDay > 0) {
    const ws = windowStart(DAY, now);
    const [tokens] = await increment([{ key: "ai_tokens_1d:global", windowStart: ws, windowMs: DAY, amount: 0 }]);
    if (tokens >= a().aiTokensPerDay) {
      return { rule: { id: "ai_tokens_1d" }, hits: tokens, retryAfterSec: Math.ceil((ws.getTime() + DAY - now) / 1000) };
    }
  }
  return null;
}

// Después de cada llamada a la IA: suma los tokens que de verdad se usaron.
async function addAiTokens(usage, now = Date.now()) {
  const total = usage ? (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0) : 0;
  if (!total) return;
  await increment([{ key: "ai_tokens_1d:global", windowStart: windowStart(DAY, now), windowMs: DAY, amount: total }]);
}

// Tope global de links guardados por día (la base gratuita tiene espacio limitado).
async function consumeGlobalShares(now = Date.now()) {
  if (a().disabled) return null;
  return consume("global", [{ id: "share_global_1d", windowMs: DAY, limit: a().sharesGlobalPerDay }], now);
}

module.exports = { quotaMiddleware, consume, consumeGlobalAi, addAiTokens, consumeGlobalShares, isNight, windowStart, hashIp, messageFor, RULES };
