// Convierte el texto de un ítem pedido en una estructura: concepto, atributos, cantidad y tokens de búsqueda.
//   "2 cuadernos A4 tapa dura rayados de 100 hojas"
//   → { quantity: 2, concept: "cuaderno", attrs: { formato: "a4", tapa: "dura", rayado: "rayado", hojas: 100 } }
const { normalize, tokenize, levenshtein, typoTolerance } = require("./text");
const { classifyRequest, getConcept, findConcepts } = require("./concepts");
const { extractRequestAttributes, extractAttributes } = require("./attributes");

// Una palabra que ya es vocabulario escolar (concepto o atributo) nunca se "corrige".
const knownCache = new Map();
function isKnownWord(w) {
  if (!knownCache.has(w)) {
    const a = extractAttributes(w);
    const hasAttr = Object.entries(a).some(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0));
    knownCache.set(w, hasAttr || findConcepts(w, "req").length > 0);
  }
  return knownCache.get(w);
}
const { TYPOS, CONTAINER_UNITS, HEAD_FILLERS } = require("../config/lexicon");
const { STOPWORDS, singular } = require("./text");

// ¿Hay una palabra desconocida antes del concepto reconocido? ("cortante de masa" → "cortante")
function unknownHeadBefore(text, index) {
  if (!index) return null;
  const words = text.slice(0, index).split(" ").filter(Boolean);
  const unknown = words.filter((w) => !(/^\d/.test(w) || STOPWORDS.has(w) || CONTAINER_UNITS.includes(singular(w)) ||
    HEAD_FILLERS.includes(w) || HEAD_FILLERS.includes(singular(w)) || isKnownWord(w)));
  return unknown.length ? unknown.join(" ") : null;
}

const NUMBER_WORDS = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, quince: 15, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50 };

// Palabras comunes que no son productos: nunca se corrigen (si no, "litro" se volvería "libro").
const PROTECTED = new Set([...CONTAINER_UNITS, ...HEAD_FILLERS, "litro", "litros", "kilos", "gramos", "metro", "metros", "mediano",
  "mediana", "grande", "grandes", "chico", "chica", "color", "colores", "claro", "claros", "oscuro", "oscuros", "nombre", "rotulado",
  "forrado", "forrada", "plastico", "plastica", "madera", "carton", "cartón", "tela", "transparente", "eleccion", "elección"]);

// Corrige errores de tipeo contra el vocabulario del catálogo (sólo palabras largas, distancia acotada).
function fixTypos(norm, vocabulary) {
  if (!vocabulary || !vocabulary.size) return norm;
  return norm
    .split(" ")
    .map((w) => {
      if (TYPOS[w]) return TYPOS[w];
      if (w.length < 5 || /\d/.test(w) || vocabulary.has(w) || isKnownWord(w) || PROTECTED.has(w)) return w;
      const tol = typoTolerance(w);
      let best = null;
      let bestD = tol + 1;
      for (const v of vocabulary) {
        if (v[0] !== w[0] || Math.abs(v.length - w.length) > tol) continue;
        const d = levenshtein(w, v);
        if (d < bestD) {
          best = v;
          bestD = d;
        }
      }
      // Sólo corregir hacia vocabulario escolar ("tigera" → "tijera"), nunca hacia cualquier palabra del catálogo.
      return best && bestD <= tol && isKnownWord(best) ? best : w;
    })
    .join(" ");
}

function leadingQuantity(norm) {
  const m = norm.match(/^(\d{1,3})\s+(.*)$/);
  if (m) return { quantity: Number(m[1]), rest: m[2] };
  const w = norm.match(/^([a-z]+)\s+(.*)$/);
  if (w && NUMBER_WORDS[w[1]] !== undefined) return { quantity: NUMBER_WORDS[w[1]], rest: w[2] };
  // "cuaderno (2)" / "cuaderno: 2" al final
  const t = norm.match(/^(.*?)\s+(\d{1,2})$/);
  if (t && !/\b(n|x|a)$/.test(t[1]) && !/\b(cm|mm|hojas?|h)$/.test(t[1])) return { quantity: Number(t[2]), rest: t[1] };
  return { quantity: null, rest: norm };
}

// "papel glase (1 fluo, 1 mate, 1 metalizado)" → tres pedidos. Sólo divide si cada parte tiene cantidad.
function splitCompound(text) {
  const m = String(text).match(/^(.*?)\(([^)]*)\)\s*$/);
  if (!m) return [text];
  const base = m[1].replace(/^\s*\d+\s+/, "").trim();
  const parts = m[2].split(/,|\by\b/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2 || !parts.every((p) => /^\d+\s+\S/.test(p))) return [text];
  return parts.map((p) => {
    const [, n, rest] = p.match(/^(\d+)\s+(.*)$/);
    return `${n} ${base} ${rest}`;
  });
}

function parseRequest(text, { quantityHint = null, vocabulary = null } = {}) {
  const raw = String(text || "").trim();
  const norm0 = normalize(raw);
  const { quantity: q, rest } = leadingQuantity(norm0);
  const norm = fixTypos(rest, vocabulary);
  const { concept, alternatives, accepted, conceptIndex, text: classifiedText } = classifyRequest(norm);
  const attrs = extractRequestAttributes((q ? q + " " : "") + norm);
  const conceptDef = getConcept(concept);
  // "40 hojas A4": el 40 es la cantidad de hojas pedidas, no una característica del producto.
  if (q && conceptDef && conceptDef.packUnit === "hoja" && /^hojas?\b/.test(norm) && attrs.hojas === q) attrs.hojas = null;
  // Si la IA dejó el número dentro del texto ("50 hojas A4", cantidad 1), manda el del texto.
  const hint = quantityHint && !(quantityHint === 1 && q) ? quantityHint : null;
  const quantity = Math.max(1, Math.min(999, hint || q || attrs.quantity || 1));
  return {
    raw,
    norm,
    tokens: tokenize(norm.replace(/\b(no|sin|ni)\s+(\w+\s?){1,2}/g, " ")),
    // "no bicolor", "sin dibujos", "(NO PLÁSTICA)": productos con esas palabras quedan atrás
    negated: [...norm.matchAll(/\b(?:no|sin|ni)\s+(\w{4,})/g)].map((m) => m[1]),
    concept,
    alternatives,
    accepted: accepted || [],
    unknownHead: concept ? unknownHeadBefore(classifiedText, conceptIndex) : null,
    outOfScope: conceptDef && conceptDef.outOfScope ? conceptDef.outOfScope : null,
    attrs,
    quantity,
    quantityWasExplicit: Boolean(quantityHint || q),
  };
}

module.exports = { parseRequest, splitCompound, fixTypos, leadingQuantity };
