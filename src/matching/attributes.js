// Atributos estructurados a partir de texto normalizado. Se usa igual para pedidos y para nombres de
// producto, así ambos lados hablan el mismo idioma ("A4", "rayado", "x12", "zurdo"…).
const { BRANDS, CONTAINER_UNITS } = require("../config/lexicon");
const { singular } = require("./text");

// Colores con sus formas (roja/rojos/rojas → rojo).
const COLOR_PATTERNS = {
  rojo: /\broj[ao]s?\b/, azul: /\bazul(es)?\b/, negro: /\bnegr[ao]s?\b/, verde: /\bverdes?\b/, amarillo: /\bamarill[ao]s?\b/,
  blanco: /\bblanc[ao]s?\b/, celeste: /\bcelestes?\b/, naranja: /\bnaranjas?\b/, rosa: /\brosas?\b/, violeta: /\bvioletas?\b|\bpurpura\b|\bmorad[ao]\b/,
  lila: /\blilas?\b/, marron: /\bmarron(es)?\b/, gris: /\bgris(es)?\b/, dorado: /\bdorad[ao]s?\b/, plateado: /\bplatead[ao]s?\b/,
  fucsia: /\bfucsias?\b/, turquesa: /\bturquesas?\b/, bordo: /\bbordo\b/, beige: /\bbeige\b/,
};
const COLORS = Object.keys(COLOR_PATTERNS);
const detectColors = (t) => COLORS.filter((c) => COLOR_PATTERNS[c].test(t));

// Dimensiones que, si ambos lados especifican valores distintos, hacen incompatible al producto.
// "compat" lista pares que NO se consideran conflicto.
// Excepciones por concepto (p.ej. folio N°3 ≈ A4) van en el lexicón: { compat: { formato: [["n3", "a4"]] } }.
const DIMENSIONS = {
  formato: {},
  rayado: {},
  tapa: {},
  punta: {},
  mina: {},
  zurdo: {},
  acabado: { compat: [["lustre", "liso"], ["liso", "negro"], ["liso", "blanco"], ["liso", "color"]] },
  medida: {},
  dureza: {},
  tipoMapa: {},
  grosor: {},
};

const brandPatterns = BRANDS.slice()
  .sort((a, b) => b.length - a.length)
  .map((b) => ({ brand: b, re: new RegExp(`\\b${b.replace(/\s+/g, "\\s+")}\\b`) }));

function detectBrand(text) {
  for (const { brand, re } of brandPatterns) if (re.test(text)) return brand.replace(/^dos banderas$/, "2 banderas");
  return null;
}

function detectFormato(t) {
  if (/\b(oficio|legal)\b/.test(t)) return "oficio";
  if (/\ba4\b/.test(t)) return "a4";
  if (/\ba5\b/.test(t)) return "a5";
  if (/\ba3\b/.test(t)) return "a3";
  if (/\bcarta\b/.test(t)) return "carta";
  const n = t.match(/\bn([1-9])\b/);
  if (n) return "n" + n[1];
  // "block número 5", "block 5" (sólo para blocks/repuestos se pide el número suelto)
  // "carpeta 3 solapas" / "carpeta de 3 anillos" no son N°3
  const nb = t.match(/\b(block|repuesto|carpeta|mapa)s?\b(?: de dibujo)?\s+([356])\b(?!\s*(solapa|anillo|gancho|tapa|hoja|unidad|cm|mm))/);
  if (nb) return "n" + nb[2];
  return null;
}

function detectRayado(t) {
  if (/cuadricul|cuadritos|\bcuadros?\b|cuadriculado|\bcuad\b/.test(t)) return "cuadriculado";
  if (/rayad|renglon|\blineas?\b/.test(t)) return "rayado";
  if (/\blis[ao]s?\b/.test(t)) return "liso";
  return null;
}

function detectAcabado(t) {
  if (/glitter|brillo|brillant|escarchad|diamantad/.test(t)) return "glitter";
  if (/metaliz/.test(t)) return "metalizado";
  if (/\bfluo|fluor|neon\b/.test(t)) return "fluo";
  if (/\bpastel\b/.test(t)) return "pastel";
  if (/lustre|\bmate\b|opaco/.test(t)) return "lustre";
  if (/\blis[ao]s?\b/.test(t)) return "liso";
  if (/\bnegr[ao]s?\b|\bnoir\b/.test(t) && /\b(hoja|repuesto|block|cartulina|canson)/.test(t)) return "negro";
  if (/\bcolou?r(es)?\b/.test(t) && /\b(hoja|repuesto|block|canson|resma)/.test(t)) return "color";
  if (/\bblanc[ao]s?\b/.test(t) && /\b(hoja|repuesto|block|canson|resma)/.test(t)) return "blanco";
  return null;
}

function detectSheets(t) {
  const m = t.match(/\bx?(\d{2,4})\s?(h|hs|hjs|hojas?)\b/) || t.match(/\b(\d{2,4})\s+hojas?\b/);
  return m ? Number(m[1]) : null;
}

// "x12", "x 50 u.", "x10 unidades", "pack 6" → unidades por paquete.
function detectPackSize(t) {
  const m = t.match(/\bx(\d{1,4})\s?(u|un|uds?|unid|unidades|pz|pzs|piezas|colores|col|hojas?|h)?\b/) ||
    t.match(/\b(?:pack|paquete|caja|set) (?:de |x)?(\d{1,4})\b/);
  return m ? Number(m[1]) : null;
}

function detectMedida(t) {
  const m = t.match(/\b(\d{2})\s?cm\b/);
  return m ? m[1] + "cm" : null;
}

function detectPunta(t) {
  if (/punta (fina|0\.[57])|trazo fino|\b0\.[57]\b(?!\s?mm? (mina|hb))|\bfina\b/.test(t)) return "fina";
  if (/punta gruesa|trazo grueso|\b1\.?0?\s?mm\b|\bgruesa?\b|\bjumbo\b/.test(t)) return "gruesa";
  return null;
}

function detectMina(t) {
  const m = t.match(/\b(0\.[3579]|2\.0)\b/);
  return m ? m[1] : null;
}

function extractAttributes(normText) {
  const t = normText;
  const colors = detectColors(t);
  return {
    formato: detectFormato(t),
    rayado: detectRayado(t),
    tapa: /tapa dura|\bt ?d\b/.test(t) ? "dura" : /tapa blanda|tapa flexible/.test(t) ? "blanda" : null,
    espiral: /espiral|\besp\b|anillad/.test(t) ? true : null,
    hojas: detectSheets(t),
    packSize: detectPackSize(t),
    acabado: detectAcabado(t),
    punta: detectPunta(t),
    mina: detectMina(t),
    zurdo: /zurd/.test(t) ? "zurdo" : null,
    medida: detectMedida(t),
    dureza: (t.match(/\b([2-6]?b|hb|2h)\b/) || [])[1] || null,
    tipoMapa: /fisic\w*\W+politic|politic\w*\W+fisic/.test(t) ? null : /politic/.test(t) ? "politico" : /fisic/.test(t) ? "fisico" : null,
    grosor: /\bgruesa?s?\b|\b11\s?mm\b/.test(t) ? "gruesa" : /\bfinas?\b|\b7\s?mm\b/.test(t) ? "fina" : null,
    largo: /\blargo/.test(t) ? "largo" : /\bcorto/.test(t) ? "corto" : null,
    brand: detectBrand(t),
    colors,
  };
}

// Atributos de un pedido + datos de cantidad.
//   "2 cuadernos A4 tapa dura rayados de 100 hojas" → quantity 2, unit "cuaderno", formato a4, tapa dura, rayado, hojas 100
function extractRequestAttributes(normText) {
  const attrs = extractAttributes(normText);
  const qtyMatch = normText.match(/^(\d{1,3})\s+(?!(cm|mm|x)\b)(\S+)/);
  const quantity = qtyMatch ? Number(qtyMatch[1]) : null;
  const unitWord = qtyMatch ? singular(qtyMatch[3]) : singular(normText.split(" ")[0] || "");
  const container = CONTAINER_UNITS.find((u) => unitWord === u || unitWord === u + "s") || null;
  // "de 12" después de un envase: "caja de 12 lapices"
  const contentMatch = normText.match(/\b(?:caja|paquete|paq|pack|set|estuche|bolsa|sobre|block)s? (?:de )?(\d{1,4})\b/);
  return {
    ...attrs,
    quantity,
    unitWord,
    container,
    contentCount: attrs.packSize || (contentMatch ? Number(contentMatch[1]) : null),
    brandOptional: /o similar|o equivalente|o parecido|tipo\s/.test(normText),
  };
}

function dimensionConflict(dim, a, b, extraCompat = []) {
  if (a == null || b == null || a === b) return false;
  const compat = [...((DIMENSIONS[dim] && DIMENSIONS[dim].compat) || []), ...extraCompat];
  return !compat.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

module.exports = { extractAttributes, extractRequestAttributes, dimensionConflict, detectColors, DIMENSIONS, COLORS };
