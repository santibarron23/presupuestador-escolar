// Motor de matching determinístico:
//   pedido → concepto + atributos → candidatos del mismo concepto → restricciones → ranking → confianza
// No llama a la IA. La IA sólo interviene después (ai/rerank.js) para ítems con confianza media.
const { parseRequest } = require("./requestParser");
const { getConcept } = require("./concepts");
const { violations } = require("./constraints");
const { chooseVariantAndQuantity, packsFor } = require("./quantity");
const { RULES, EXCLUDE_UNLESS_REQUESTED } = require("../config/matchingRules");

const CONFIDENCE = { muy_alta: 0.95, alta: 0.8, media: 0.6, baja: 0.3 };
const IMPORTANT_DIMS = ["formato", "rayado", "acabado", "punta", "mina", "medida", "tipoMapa"];

function ruleApplies(rule, req) {
  const w = rule.when || {};
  if (w.match && !w.match.test(req.norm)) return false;
  if (w.notMatch && w.notMatch.test(req.norm)) return false;
  for (const [k, v] of Object.entries(w.attrs || {})) {
    if (req.attrs[k] !== v) return false;
  }
  return true;
}

function applicableRules(req, concepts) {
  return RULES.filter((r) => concepts.includes(r.concept) && ruleApplies(r, req)).sort(
    (a, b) => (b.priority || 0) - (a.priority || 0),
  );
}

function preferredIndex(rules, product, store) {
  let best = null;
  rules.forEach((rule, ri) => {
    (rule.prefer || []).forEach((ref, pi) => {
      const p = store.findRef(ref);
      if (p && p.id === product.id) {
        const rank = ri * 10 + pi;
        if (best === null || rank < best.rank) best = { rank, rule: rule.id, priority: rule.priority || 0 };
      }
    });
  });
  return best;
}

function scoreCandidate(req, product, ctx) {
  const { rules, store, maxBm25, priceRank } = ctx;
  let score = 0;
  const why = [];

  const lexical = maxBm25 > 0 ? store.bm25(product, req.tokens) / maxBm25 : 0;
  score += 0.35 * lexical;
  // Concepto aceptado pero no el pedido ("repuesto canson" → también sirve un block): queda detrás.
  if (req.concept && req.accepted.includes(product.concept)) score -= 0.2;

  const conceptDef = getConcept(product.concept);
  let missingImportant = 0;
  for (const dim of (conceptDef && conceptDef.dims) || []) {
    const want = req.attrs[dim];
    if (want == null) continue;
    const have = product.attrs[dim];
    if (have != null && (have === want || dim === "hojas")) {
      score += 0.12;
      why.push(dim);
    } else if (have == null) {
      // ¿Lo resuelve una variante? ("Folios A4 LUMA" tiene variantes A4/oficio; "Tempera" tiene colores)
      const inVariants = product.variants.some((v) => String(want).length > 1 && v.optionsNorm.includes(String(want).replace(/^n(\d)$/, "$1")));
      if (inVariants) score += 0.08;
      else if (IMPORTANT_DIMS.includes(dim)) {
        score -= 0.08;
        missingImportant++;
      }
    }
  }

  // Marca
  let brandMismatch = false;
  if (req.attrs.brand && !["voligoma", "plasticola", "boligoma"].includes(req.attrs.brand)) {
    if (product.attrs.brand === req.attrs.brand || product.norm.includes(req.attrs.brand)) {
      score += 0.3;
      why.push("marca");
    } else {
      score -= req.attrs.brandOptional ? 0.05 : 0.3;
      brandMismatch = !req.attrs.brandOptional;
    }
  }

  // Reglas comerciales
  const pref = preferredIndex(rules, product, store);
  if (pref) {
    score += 0.6 - Math.min(0.4, pref.rank * 0.1) + 0.02 * pref.priority;
    why.push("preferido:" + pref.rule);
  }
  // Paquete que calza justo con lo pedido ("10 plastilinas" → paquete x10 antes que 2 x6).
  if (conceptDef && conceptDef.packUnit && req.quantityWasExplicit && !req.attrs.container && req.quantity > 1) {
    const units = product.variants.filter((v) => v.sellable).map((v) => v.unitsPerPack);
    if (units.includes(req.quantity)) score += 0.2;
    else if (units.some((u) => u > 1 && req.quantity % u === 0)) score += 0.1;
  }
  for (const rule of rules) {
    for (const re of rule.boost || []) if (re.test(product.norm)) score += 0.15;
  }
  for (const rule of EXCLUDE_UNLESS_REQUESTED) {
    if (rule.soft && rule.product.test(product.norm) && !rule.request.test(req.norm)) score -= 0.1;
  }

  // A igualdad, preferir lo más accesible (sin dominar: el más barato no siempre es el correcto).
  score -= 0.08 * (priceRank.get(product.id) || 0);

  return { score, lexical, preferred: pref, missingImportant, brandMismatch, why };
}

function confidenceFor(req, top, second) {
  // "cortante de masa": reconocimos "masa" pero el pedido es otra cosa. No adivinar.
  if (req.unknownHead) return "baja";
  if (!req.concept) {
    // Sin categoría reconocida no podemos validar el tipo de producto: nunca alta.
    const allTokens = req.tokens.length >= 2 && req.tokens.every((t) => top.product.tokens.includes(t));
    return allTokens ? "media" : "baja";
  }
  if (top.brandMismatch) return "media";
  if (top.preferred && top.missingImportant === 0) return "muy_alta";
  const margin = top.score - (second ? second.score : 0);
  if (top.missingImportant === 0 && (margin >= 0.12 || !second)) return "alta";
  return "media";
}

function productView(product, choice) {
  const v = choice.variant;
  return {
    productId: product.productId,
    id: product.id,
    sku: v.sku || product.sku,
    name: product.name,
    productSku: product.sku,
    concept: product.concept,
    attrs: { formato: product.attrs.formato, rayado: product.attrs.rayado },
    variantId: v.id,
    variantLabel: v.options && v.options.length ? v.options.join(" / ") : null,
    variantOptions: v.options || [],
    hasVariants: product.variants.length > 1,
    url: product.url,
    slug: product.slug,
    imageUrl: v.imageUrl || product.imageUrl,
    brand: product.attrs.brand,
    unitPrice: v.price,
    stock: v.stock,
    unitsPerPack: choice.unitsPerPack,
  };
}

function labelAlternatives(selected, others) {
  const out = [];
  const cheapest = [...others].sort((a, b) => a.price - b.price)[0];
  if (cheapest && cheapest.price < selected.unitPrice) out.push({ ...cheapest, tag: "economico" });
  for (const o of others) {
    if (out.length >= 3) break;
    if (!out.some((x) => x.id === o.id)) out.push({ ...o, tag: "alternativa" });
  }
  return out;
}

// Match de un ítem. `opts.vocabulary` (Set) habilita la corrección de tipeo.
function matchItem(text, store, opts = {}) {
  const req = parseRequest(text, { quantityHint: opts.quantity, vocabulary: opts.vocabulary || store.wordSet });
  const base = { requestedItem: req.raw, quantity: req.quantity, concept: req.concept, attributes: compactAttrs(req.attrs) };

  if (req.outOfScope) return { ...base, status: "not_sold", reason: req.outOfScope, confidence: null, alternatives: [] };
  if (!req.concept && req.tokens.length === 0) return { ...base, status: "not_found", reason: "No entendimos este ítem.", confidence: null, alternatives: [] };

  const concepts = [req.concept, ...req.alternatives].filter((c) => c && !(getConcept(c) || {}).outOfScope);
  const rules = applicableRules(req, concepts);
  const poolConcepts = [...concepts, ...req.accepted];

  // Regla de "solo en sucursal" (p.ej. resmas blancas): sólo si ninguna regla de mayor prioridad prefiere un producto.
  const top = rules[0];
  if (top && top.inStore) {
    return { ...base, status: "in_store", confidence: "muy_alta", score: CONFIDENCE.muy_alta,
      inStore: { label: top.inStore.label, note: top.inStore.note }, rule: top.id, alternatives: [] };
  }

  // Candidatos: mismo concepto (o conceptos aceptados). Sin concepto: búsqueda léxica acotada.
  let pool;
  if (concepts.length) pool = poolConcepts.flatMap((c) => store.byConcept.get(c) || []);
  else pool = store.search(req.tokens, { limit: 30 }).map((r) => r.product);

  const ruleExcludes = rules.flatMap((r) => r.exclude || []);
  const compatible = [];
  const unavailable = [];
  for (const p of pool) {
    if (ruleExcludes.some((re) => re.test(p.norm))) continue;
    const v = violations(req, p, { checkAvailability: false });
    if (v.length) continue;
    if (!p.sellable) unavailable.push(p);
    else compatible.push(p);
  }

  if (!compatible.length) {
    if (unavailable.length) {
      const p = unavailable.sort((a, b) => store.bm25(b, req.tokens) - store.bm25(a, req.tokens))[0];
      return { ...base, status: "out_of_stock", reason: "Sin stock online en este momento.", confidence: null,
        product: { id: p.id, name: p.name, url: p.url, imageUrl: p.imageUrl }, alternatives: [] };
    }
    return { ...base, status: "not_found", reason: req.concept ? "No tenemos un producto compatible en el catálogo online." : "No encontramos este producto en el catálogo online.",
      confidence: null, alternatives: [] };
  }

  const maxBm25 = Math.max(0, ...compatible.map((p) => store.bm25(p, req.tokens)));
  const byPrice = [...compatible].sort((a, b) => minPrice(a) - minPrice(b));
  const priceRank = new Map(byPrice.map((p, i) => [p.id, compatible.length > 1 ? i / (compatible.length - 1) : 0]));
  const ctx = { rules, store, maxBm25, priceRank };

  const ranked = compatible
    .map((product) => ({ product, ...scoreCandidate(req, product, ctx) }))
    .sort((a, b) => b.score - a.score);

  // Producto forzado: desempate de la IA (debe ser un candidato compatible) o elección manual de la familia.
  let decidedBy = "engine";
  let forcedConfidence = null;
  if (opts.forceProductId) {
    const idx = ranked.findIndex((r) => r.product.id === String(opts.forceProductId));
    if (idx >= 0) {
      ranked.unshift(ranked.splice(idx, 1)[0]);
      decidedBy = opts.decidedBy || "manual";
      forcedConfidence = opts.forcedConfidence || "alta";
    } else if (opts.decidedBy === "manual") {
      // Elección manual fuera de los compatibles (otra categoría): se respeta, pero se marca.
      const p = store.get(opts.forceProductId);
      if (p && p.sellable) {
        ranked.unshift({ product: p, ...scoreCandidate(req, p, ctx) });
        decidedBy = "manual";
        forcedConfidence = "alta";
      }
    }
  }

  const best = ranked[0];
  const conceptDef = getConcept(best.product.concept);
  const choice = chooseVariantAndQuantity(best.product, req, conceptDef);
  if (opts.forceVariantId != null) {
    const v = best.product.variants.find((x) => String(x.id) === String(opts.forceVariantId) && x.sellable);
    if (v) {
      const { packs, mode } = packsFor(req, v.unitsPerPack, conceptDef);
      Object.assign(choice, { variant: v, packs, unitsPerPack: v.unitsPerPack || 1, quantityMode: mode });
    }
  }
  // Cantidad de paquetes elegida por la familia: manda sobre el cálculo.
  if (opts.packs != null) {
    choice.packs = Math.max(1, Math.min(999, parseInt(opts.packs, 10) || 1));
    choice.quantityNote = null;
  }
  let confidence = forcedConfidence || confidenceFor(req, best, ranked[1]);
  // Un sustituto (concepto aceptado, no el pedido) nunca se da por bueno solo: la familia lo confirma.
  if (!forcedConfidence && req.accepted.includes(best.product.concept) && (confidence === "alta" || confidence === "muy_alta")) confidence = "media";
  // Si no podemos asegurar la cantidad, que la familia la revise.
  if (choice.quantityMode === "unknown-pack-size" && (confidence === "alta" || confidence === "muy_alta")) confidence = "media";
  const selected = productView(best.product, choice);
  const others = ranked.slice(1, 8).map((r) => {
    const c = chooseVariantAndQuantity(r.product, req, getConcept(r.product.concept));
    const view = productView(r.product, c);
    return { ...view, price: view.unitPrice, packs: c.packs };
  });

  const status = confidence === "baja" ? "suggested" : confidence === "media" ? "review" : "matched";
  return {
    ...base,
    status,
    confidence,
    score: Number(Math.min(0.99, CONFIDENCE[confidence] + Math.max(-0.1, Math.min(0.04, best.score / 25))).toFixed(2)),
    product: selected,
    packs: choice.packs,
    quantityNote: choice.quantityNote,
    rule: best.preferred ? best.preferred.rule : null,
    decidedBy,
    alternatives: labelAlternatives(selected, others),
    candidatesConsidered: compatible.length,
  };
}

function minPrice(p) {
  const prices = p.variants.filter((v) => v.sellable).map((v) => v.price);
  return prices.length ? Math.min(...prices) : Infinity;
}

function compactAttrs(a) {
  const out = {};
  for (const [k, v] of Object.entries(a)) {
    if (v === null || v === undefined || v === false || (Array.isArray(v) && !v.length)) continue;
    if (["quantity", "unitWord", "brandOptional"].includes(k)) continue;
    out[k] = v;
  }
  return out;
}

module.exports = { matchItem, applicableRules, CONFIDENCE };
