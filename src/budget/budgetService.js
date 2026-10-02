// Orquesta el pipeline de un presupuesto:
//   archivos/texto → lectura → extracción (IA, o determinística si la IA falla) → matching determinístico
//   → desempate por IA de ítems dudosos (opcional) → precios desde catálogo → totales.
// Cada etapa tiene su fallback: una IA saturada no deja a la familia sin presupuesto.
const crypto = require("crypto");
const config = require("../config");
const { store } = require("../catalog/catalogStore");
const { readUpload } = require("../parsing/fileReader");
const { extractLines } = require("../parsing/lineExtractor");
const { extractItems } = require("../ai/extractItems");
const { rerank } = require("../ai/rerank");
const { matchItem } = require("../matching/engine");
const { logger, stageTimer } = require("../observability/logger");

const AUTO_SELECTED = new Set(["matched", "review"]);

class BudgetError extends Error {
  constructor(code, userMessage, httpStatus = 400) {
    super(userMessage);
    this.code = code;
    this.userMessage = userMessage;
    this.httpStatus = httpStatus;
  }
}

const newId = () => crypto.randomBytes(5).toString("base64url").toUpperCase().replace(/[-_]/g, "X");

// Ítem del motor → ítem de respuesta. Incluye los campos que espera el widget anterior (matched, catalogName…).
function toResponseItem(m, lineId, grade, extra = {}) {
  const selected = AUTO_SELECTED.has(m.status);
  const p = m.product;
  const unitPrice = selected && p ? p.unitPrice : 0;
  const packs = selected ? m.packs : m.quantity;
  return {
    lineId,
    requestedItem: m.requestedItem,
    requestedQuantity: m.quantity,
    grade: grade || null,
    status: m.status,
    confidence: m.confidence,
    score: m.score ?? null,
    decidedBy: m.decidedBy || null,
    reason: m.reason || null,
    quantityNote: m.quantityNote || null,
    product: p || null,
    inStore: m.inStore || null,
    alternatives: m.alternatives || [],
    concept: m.concept,
    // Opcional / reutilizable / se compra en el colegio: se muestra pero no suma al total salvo que la familia lo agregue.
    optional: Boolean(extra.optional),
    note: extra.note || null,
    // ── compatibilidad con el widget v1 ──
    quantity: packs,
    matched: selected || m.status === "in_store",
    inStoreOnly: m.status === "in_store",
    catalogId: selected && p ? p.id : null,
    catalogName: selected && p ? p.name : m.status === "in_store" ? m.inStore.label : null,
    catalogSku: selected && p ? p.sku : null,
    catalogSlug: selected && p ? p.slug : null,
    unitPrice,
    subtotal: unitPrice * packs,
  };
}

function summarize(items) {
  const count = (fn) => items.filter(fn).length;
  const sellable = items.filter((i) => i.status !== "not_sold");
  const found = count((i) => AUTO_SELECTED.has(i.status));
  const inStore = count((i) => i.status === "in_store");
  const total = items.reduce((s, i) => s + (AUTO_SELECTED.has(i.status) && !i.optional ? i.subtotal : 0), 0);
  return {
    totalItems: items.length,
    foundItems: found,
    matchedItems: count((i) => i.status === "matched"),
    // Elegidos automáticamente pero con alternativas: conviene que la familia los mire.
    reviewItems: count((i) => i.status === "review"),
    // No elegidos: hay sugerencias pero la familia tiene que decidir.
    suggestedItems: count((i) => i.status === "suggested"),
    inStoreItems: inStore,
    notFoundItems: count((i) => ["not_found", "not_sold", "out_of_stock", "suggested"].includes(i.status)),
    // La cobertura se mide sobre lo que una librería puede vender (sin higiene, libros, etc.).
    coveragePercent: sellable.length ? Math.round(((found + inStore) / sellable.length) * 100) : 0,
    estimatedTotal: Math.round(total * 100) / 100,
  };
}

async function readSources({ files = [], text }) {
  if (text && text.trim()) return { kind: "text", text: text.trim().slice(0, config.http.maxPastedChars) };
  const read = [];
  for (const f of files) read.push(await readUpload(f));
  if (!read.length) throw new BudgetError("empty", "Subí una foto o un archivo con la lista, o pegá el texto.");
  // Todo texto: se une y se procesa como texto (más barato). Si hay fotos/PDF escaneado, va todo junto a la IA.
  if (read.every((r) => r.kind === "text")) return { kind: "text", text: read.map((r) => r.text).join("\n\n") };
  return { kind: "files", files: read };
}

async function extract(source, warnings) {
  try {
    const out = await extractItems(source);
    if (!out.readable || !out.items.length) {
      if (source.kind === "text") return { ...extractLines(source.text), method: "deterministic" };
      throw new BudgetError("unreadable", "No pudimos leer una lista de útiles en la imagen. Probá con una foto más nítida y derecha, o pegá el texto.", 422);
    }
    return { items: out.items, method: "ai", model: out.model, usage: out.usage };
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    // IA caída/saturada: con texto seguimos sin IA; con fotos no hay forma de leerlas.
    if (source.kind === "text") {
      warnings.push("Leímos la lista sin asistencia de IA: revisá que estén todos los ítems.");
      return { ...extractLines(source.text), method: "deterministic", aiError: e.code };
    }
    throw new BudgetError("ai_unavailable", "En este momento no podemos leer fotos. Probá de nuevo en un minuto, o pegá el texto de la lista.", 503);
  }
}

async function disambiguate(items, results, warnings) {
  const max = config.ai.rerankMaxItems;
  if (!max) return 0;
  const entries = [];
  results.forEach((m, i) => {
    if (m.status !== "review" || !m.product || !m.alternatives.length || entries.length >= max) return;
    const candidates = [m.product, ...m.alternatives.slice(0, 4)].map((c) => ({ ref: c.id, name: c.name + (c.variantLabel ? ` (${c.variantLabel})` : ""), price: c.unitPrice ?? c.price }));
    entries.push({ key: i, request: m.requestedItem, candidates });
  });
  if (!entries.length) return 0;
  try {
    const { decisions } = await rerank(entries);
    let changed = 0;
    for (const [i, choice] of decisions) {
      const m = results[i];
      if (choice === null) {
        // La IA tampoco ve un candidato claro: no se elige automáticamente.
        results[i] = { ...m, status: "suggested", confidence: "baja", decidedBy: "ai" };
        continue;
      }
      // Se recalcula con el motor (vuelve a validar restricciones, variante y cantidad).
      results[i] = matchItem(items[i].text, store, { quantity: items[i].quantity, forceProductId: choice, decidedBy: "ai", forcedConfidence: "alta" });
      if (choice !== m.product.id) changed++;
    }
    return changed;
  } catch (e) {
    warnings.push("Algunos productos quedaron para que los revises vos.");
    logger.warn("rerank_skipped", { code: e.code });
    return 0;
  }
}

// onStage(nombre, datos) informa el avance real (para la barra de progreso del widget).
async function createBudget({ files, text, useAi = true, onStage = () => {} }) {
  const timer = stageTimer();
  const warnings = [];
  onStage("reading");
  const source = await readSources({ files, text });
  timer.stage("read");

  onStage("extracting");
  const extraction = useAi ? await extract(source, warnings) : { ...extractLines(source.text || ""), method: "deterministic" };
  timer.stage("extract");
  if (!extraction.items.length) {
    throw new BudgetError("no_items", "No encontramos productos en la lista. Revisá que sea una lista de útiles o pegá el texto.", 422);
  }

  onStage("matching", { items: extraction.items.length });
  const results = extraction.items.map((it) => matchItem(it.text, store, { quantity: it.quantity }));
  timer.stage("match");

  const needsRerank = results.some((r) => r.status === "review");
  if (needsRerank && useAi && extraction.method === "ai") onStage("checking");
  const reranked = useAi && extraction.method === "ai" ? await disambiguate(extraction.items, results, warnings) : 0;
  timer.stage("rerank");
  onStage("pricing");

  const items = results.map((m, i) => toResponseItem(m, i + 1, extraction.items[i].grade, extraction.items[i]));
  const grades = [...new Set(items.map((i) => i.grade).filter(Boolean))];
  const summary = summarize(items);
  const timings = timer.done();

  const confidences = results.filter((r) => r.score).map((r) => r.score);
  logger.info("budget_created", {
    method: extraction.method, sourceKind: source.kind, items: items.length, found: summary.foundItems,
    review: summary.reviewItems, notFound: summary.notFoundItems, coverage: summary.coveragePercent,
    avgConfidence: confidences.length ? Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(2)) : null,
    candidates: results.reduce((s, r) => s + (r.candidatesConsidered || 0), 0), reranked,
    inputTokens: extraction.usage ? extraction.usage.input_tokens : 0, outputTokens: extraction.usage ? extraction.usage.output_tokens : 0,
    timings,
  });

  return {
    success: true,
    id: newId(),
    createdAt: new Date().toISOString(),
    summary,
    items,
    grades,
    warnings,
    catalog: { syncedAt: store.meta.syncedAt || null, source: store.meta.source || null },
    meta: { extraction: extraction.method, timings },
    rawText: "",
  };
}

// Re-matchea líneas editadas por la familia, sin IA (instantáneo y gratis).
function matchLines(lines) {
  const items = lines.slice(0, 200).map((l, i) => {
    const m = matchItem(String(l.text || "").slice(0, 200), store, {
      quantity: l.quantity,
      forceProductId: l.productId || null,
      forceVariantId: l.variantId ?? null,
      packs: l.packs ?? null,
      decidedBy: l.productId ? "manual" : undefined,
      forcedConfidence: l.productId ? "alta" : undefined,
    });
    return toResponseItem(m, l.lineId ?? i + 1, l.grade, { optional: l.optional, note: l.note ? String(l.note).slice(0, 120) : null });
  });
  return { items, summary: summarize(items) };
}

// Precios definitivos desde el catálogo para líneas elegidas en el navegador (PDF, carrito, WhatsApp).
// Nunca se usan precios que vengan del cliente.
function priceLines(lines) {
  const out = [];
  for (const l of lines.slice(0, 300)) {
    const requestedItem = String(l.requestedItem || "").slice(0, 200);
    const packs = Math.max(1, Math.min(999, parseInt(l.packs ?? l.quantity, 10) || 1));
    const p = l.productId != null ? store.get(l.productId) : null;
    const v = p && (p.variants.find((x) => String(x.id) === String(l.variantId)) || p.variants.find((x) => x.sellable));
    if (!p || !v || !v.sellable) {
      out.push({ requestedItem, packs, available: false });
      continue;
    }
    out.push({
      requestedItem, packs, available: true,
      productId: p.id, storeProductId: p.productId, variantId: v.id, variantLabel: v.options.join(" / ") || null, variantOptions: v.options,
      name: p.name, sku: v.sku || p.sku, url: p.url, imageUrl: v.imageUrl || p.imageUrl,
      unitPrice: v.price, subtotal: v.price * packs,
    });
  }
  const total = out.reduce((s, l) => s + (l.available ? l.subtotal : 0), 0);
  return { lines: out, total: Math.round(total * 100) / 100 };
}

module.exports = { createBudget, matchLines, priceLines, summarize, BudgetError };
