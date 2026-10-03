// Métricas propias, anónimas y agregadas (sin cookies, sin IDs de usuario, sin IP). Alimentan el panel /admin:
// cuántos presupuestos, cobertura, qué se pide que no está en la tienda, qué productos cambian las familias,
// y cuántos terminan en carrito / WhatsApp / PDF. GA4 sigue recibiendo los eventos vía la página de la tienda.
const { getStorage } = require("../storage");
const { normalize } = require("../matching/text");
const { store } = require("../catalog/catalogStore");
const { logger } = require("../observability/logger");

const UNMET = new Set(["not_found", "not_sold", "out_of_stock", "suggested"]);
const FOUND = new Set(["matched", "review"]);

// Día en Argentina (UTC-3, sin horario de verano).
const today = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

// Errores de la base nunca afectan a la familia: se registran y listo.
function fireAndForget(promise, what) {
  Promise.resolve(promise).catch((e) => logger.warn("metrics_write_failed", { what, message: e.message }));
}

// Clave de demanda: el pedido sin cantidad ni detalles de más, para agrupar "2 hojas canson n5" y "hojas canson N°5".
function demandKey(text) {
  return normalize(text).replace(/^\d+\s+/, "").replace(/\b(de|del|la|el|los|las|un|una)\b/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

function budgetIncrements(budget) {
  const inc = { budgets: 1, items: budget.items.length };
  inc[`budgets_${budget.meta && budget.meta.extraction === "ai" ? "ai" : "text"}`] = 1;
  inc.estimated_total_ars = Math.round(budget.summary.estimatedTotal || 0);
  const meta = budget.meta || {};
  if (meta.cached) inc.ai_cache_hits = 1;
  if (meta.usage) Object.assign(inc, { ai_calls: 1, ai_input_tokens: meta.usage.input, ai_output_tokens: meta.usage.output });
  if (meta.timings && meta.timings.total) inc.duration_ms = meta.timings.total;
  for (const it of budget.items) {
    inc[`status.${it.status}`] = (inc[`status.${it.status}`] || 0) + 1;
    if (it.concept) {
      inc[`req.${it.concept}`] = (inc[`req.${it.concept}`] || 0) + 1;
      if (FOUND.has(it.status)) inc[`hit.${it.concept}`] = (inc[`hit.${it.concept}`] || 0) + 1;
    }
  }
  return inc;
}

function demandEntries(budget) {
  const seen = new Set();
  const out = [];
  for (const it of budget.items) {
    if (!UNMET.has(it.status)) continue;
    const key = demandKey(it.requestedItem);
    if (key.length < 3 || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, sample: String(it.requestedItem).slice(0, 100), concept: it.concept || null, status: it.status });
  }
  return out;
}

// Latencias recientes en memoria (últimos 500 presupuestos) para p50/p95 en /api/health y el panel.
const recentDurations = [];
function latency() {
  if (!recentDurations.length) return { samples: 0, p50Ms: null, p95Ms: null };
  const s = [...recentDurations].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { samples: s.length, p50Ms: at(0.5), p95Ms: at(0.95) };
}

function recordBudget(budget) {
  const total = budget.meta && budget.meta.timings && budget.meta.timings.total;
  if (total) {
    recentDurations.push(total);
    if (recentDurations.length > 500) recentDurations.shift();
  }
  const s = getStorage();
  fireAndForget(s.addMetrics(today(), budgetIncrements(budget)), "budget");
  const demand = demandEntries(budget);
  if (demand.length) fireAndForget(s.addDemand(demand), "demand");
}

// Eventos que puede mandar el widget (lista cerrada; el resto se ignora).
const CLIENT_EVENTS = {
  add_to_cart_clicked: (p) => ({ "ev.add_to_cart_clicked": 1, cart_value_ars: clampInt(p.total, 0, 10000000), cart_items: clampInt(p.items, 0, 300) }),
  cart_result: (p) => ({ "ev.cart_result": 1, cart_added: clampInt(p.added, 0, 300), cart_failed: clampInt(p.failed, 0, 300) }),
  whatsapp_clicked: () => ({ "ev.whatsapp_clicked": 1 }),
  pdf_downloaded: () => ({ "ev.pdf_downloaded": 1 }),
  share_clicked: () => ({ "ev.share_clicked": 1 }),
  alternative_selected: () => ({ "ev.alternative_selected": 1 }),
  product_added_manually: () => ({ "ev.product_added_manually": 1 }),
  product_removed: () => ({ "ev.product_removed": 1 }),
  item_text_corrected: () => ({ "ev.item_text_corrected": 1 }),
  budget_failed: () => ({ "ev.budget_failed": 1 }),
};

function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0;
}

function recordClientEvent(name, params = {}) {
  const fn = CLIENT_EVENTS[name];
  if (!fn) return false;
  fireAndForget(getStorage().addMetrics(today(), fn(params || {})), "event");
  return true;
}

// Sustitución: el motor propuso un producto y la familia eligió otro. Sólo IDs de catálogo y concepto.
function recordSubstitution({ concept, fromId, toId }) {
  const valid = (id) => id != null && store.get(String(id));
  if (!valid(fromId) || !valid(toId) || String(fromId) === String(toId)) return false;
  const c = String(concept || store.get(String(toId)).concept || "otro").slice(0, 40);
  fireAndForget(getStorage().addSubstitution({ concept: c, fromId: String(fromId), toId: String(toId) }), "substitution");
  return true;
}

function recordMetric(name, value = 1) {
  fireAndForget(getStorage().addMetrics(today(), { [name]: value }), name);
}

// ── Reporte para el panel ─────────────────────────────────────────
async function buildReport({ days = 30, ops = null } = {}) {
  const since = new Date(Date.now() - days * 86400000);
  const r = await getStorage().report({ since });
  const totals = {};
  const daily = {};
  for (const { day, metric, value } of r.metrics) {
    totals[metric] = (totals[metric] || 0) + value;
    if (["budgets", "ev.add_to_cart_clicked", "ev.whatsapp_clicked"].includes(metric)) {
      daily[day] = daily[day] || { day, budgets: 0, cart: 0, whatsapp: 0 };
      daily[day][metric === "budgets" ? "budgets" : metric === "ev.whatsapp_clicked" ? "whatsapp" : "cart"] += value;
    }
  }
  const t = (k) => totals[k] || 0;
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const unmetItems = [...UNMET].reduce((s, st) => s + t(`status.${st}`), 0);
  const sellableItems = t("items") - t("status.not_sold");

  const concepts = Object.keys(totals).filter((k) => k.startsWith("req.")).map((k) => {
    const id = k.slice(4);
    return { concept: id, requested: totals[k], found: t(`hit.${id}`), foundRate: pct(t(`hit.${id}`), totals[k]) };
  }).sort((a, b) => b.requested - a.requested);

  const productName = (id) => {
    const p = store.get(id);
    return p ? p.name : `(producto ${id} ya no está en el catálogo)`;
  };

  return {
    range: { days, since: since.toISOString() },
    storage: { kind: getStorage().kind, persistent: getStorage().persistent },
    catalog: { products: store.products.length, syncedAt: store.meta.syncedAt || null },
    kpis: {
      budgets: t("budgets"),
      budgetsFromPhotos: t("budgets_ai"),
      items: t("items"),
      // Cobertura sobre lo que una librería vende (sin higiene, libros, ropa…)
      coveragePercent: pct(t("status.matched") + t("status.review") + t("status.in_store"), sellableItems),
      autoSelectedPercent: pct(t("status.matched"), t("items")),
      unmetItems,
      avgBudgetArs: t("budgets") ? Math.round(t("estimated_total_ars") / t("budgets")) : 0,
      avgCartArs: t("ev.add_to_cart_clicked") ? Math.round(t("cart_value_ars") / t("ev.add_to_cart_clicked")) : 0,
      savedBudgets: r.savedBudgets,
      sharedOpened: t("share_opened"),
    },
    funnel: [
      { step: "Presupuestos armados", value: t("budgets") },
      { step: "Agregar al carrito", value: t("ev.add_to_cart_clicked"), rate: pct(t("ev.add_to_cart_clicked"), t("budgets")) },
      { step: "Productos agregados al carrito", value: t("cart_added") },
      { step: "WhatsApp", value: t("ev.whatsapp_clicked"), rate: pct(t("ev.whatsapp_clicked"), t("budgets")) },
      { step: "PDF", value: t("ev.pdf_downloaded"), rate: pct(t("ev.pdf_downloaded"), t("budgets")) },
      { step: "Links compartidos", value: t("share_created"), rate: pct(t("share_created"), t("budgets")) },
    ],
    edits: {
      alternativeSelected: t("ev.alternative_selected"),
      addedManually: t("ev.product_added_manually"),
      removed: t("ev.product_removed"),
      textCorrected: t("ev.item_text_corrected"),
      failed: t("ev.budget_failed"),
    },
    // Operación: costo (tokens) y velocidad. `live` = estado actual del proceso (fila de IA, caché, sync).
    ops: {
      aiCalls: t("ai_calls"),
      aiCacheHits: t("ai_cache_hits"),
      aiCacheHitPercent: pct(t("ai_cache_hits"), t("ai_calls") + t("ai_cache_hits")),
      avgInputTokens: t("ai_calls") ? Math.round(t("ai_input_tokens") / t("ai_calls")) : 0,
      avgOutputTokens: t("ai_calls") ? Math.round(t("ai_output_tokens") / t("ai_calls")) : 0,
      avgDurationMs: t("budgets") ? Math.round(t("duration_ms") / t("budgets")) : 0,
      latency: latency(),
      live: ops || null,
    },
    statuses: Object.fromEntries(Object.keys(totals).filter((k) => k.startsWith("status.")).map((k) => [k.slice(7), totals[k]])),
    daily: Object.values(daily).sort((a, b) => a.day.localeCompare(b.day)),
    concepts: concepts.slice(0, 40),
    demand: r.demand.map((d) => ({ text: d.sample, concept: d.concept, status: d.status, hits: d.hits, lastSeen: d.lastSeen })),
    substitutions: r.substitutions.map((s) => ({ concept: s.concept, from: productName(s.fromId), to: productName(s.toId), fromId: s.fromId, toId: s.toId, hits: s.hits })),
  };
}

module.exports = { recordBudget, recordClientEvent, recordSubstitution, recordMetric, buildReport, latency, demandKey, budgetIncrements, demandEntries, today, CLIENT_EVENTS };
