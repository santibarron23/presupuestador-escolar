// Reconoce el concepto de producto (lexicón) en un texto ya normalizado.
const { CONCEPTS } = require("../config/lexicon");

const BY_ID = new Map(CONCEPTS.map((c, i) => [c.id, { ...c, order: i }]));

function firstIndex(text, patterns) {
  let best = -1;
  for (const re of patterns || []) {
    const m = re.exec(text);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

// Todos los conceptos presentes, ordenados por posición en el texto y luego por especificidad.
function findConcepts(text, side /* "req" | "prod" */) {
  const hits = [];
  for (const [id, c] of BY_ID) {
    const patterns = side === "prod" ? c.prod : c.req;
    if (!patterns) continue;
    const idx = firstIndex(text, patterns);
    if (idx === -1) continue;
    if (side === "prod" && c.notProd && firstIndex(text, c.notProd) !== -1) continue;
    hits.push({ id, index: idx, order: c.order });
  }
  // Patrones genéricos ("hojas" a secas) sólo cuentan si ningún concepto específico matcheó.
  if (!hits.length && side === "req") {
    for (const [id, c] of BY_ID) {
      const idx = firstIndex(text, c.reqFallback);
      if (idx !== -1) hits.push({ id, index: idx, order: c.order });
    }
  }
  hits.sort((a, b) => a.index - b.index || a.order - b.order);
  return hits;
}

function classifyProduct(normName) {
  const hits = findConcepts(normName, "prod");
  return hits.length ? hits[0].id : null;
}

// Para un pedido devuelve el concepto principal y, si el pedido ofrece opciones ("plasticola o voligoma"),
// los conceptos alternativos aceptados.
function classifyRequest(normText) {
  const text = normText.replace(/\bo (similar|equivalente|parecido)\b/g, " ").trim();
  const segments = text.split(/\s(?:o|u|y\/o)\s/).filter(Boolean);
  const primaryHits = findConcepts(text, "req");
  if (!primaryHits.length) return { concept: null, alternatives: [] };
  const concept = primaryHits[0].id;
  // alternatives: opciones explícitas del pedido ("plasticola o voligoma") → sus reglas comerciales cuentan.
  // accepted: sustitutos aceptables por definición del concepto → sólo amplían candidatos.
  const alternatives = new Set();
  if (segments.length > 1) {
    for (const seg of segments) {
      const h = findConcepts(seg, "req");
      if (h.length && h[0].id !== concept) alternatives.add(h[0].id);
    }
  }
  const accepted = (BY_ID.get(concept).accepts || []).filter((a) => !alternatives.has(a));
  return { concept, alternatives: [...alternatives], accepted, conceptIndex: primaryHits[0].index, text };
}

const getConcept = (id) => (id ? BY_ID.get(id) || null : null);

module.exports = { classifyProduct, classifyRequest, getConcept, findConcepts };
