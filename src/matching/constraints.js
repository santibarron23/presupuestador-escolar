// Validación de compatibilidad pedido ↔ producto. Fuente única de verdad: la usa el ranking para filtrar
// candidatos y se vuelve a correr sobre el resultado final (incluido lo que elija la IA en el desempate).
//
// Incompatibilidades que detecta:
//   - categoría distinta (lápiz vs bolígrafo, folio vs hoja, fibra vs marcador de pizarra…) → concepto
//   - A4 vs oficio, N°3 vs N°5 → dim "formato"
//   - rayado vs cuadriculado vs liso → dim "rayado"
//   - punta fina vs gruesa, mina 0.5 vs 0.7, regla 20 vs 30 cm, zurdo, glitter vs lisa…
//   - características que sólo van si se piden (zurdo, Oxford, carpeta con folios…)
//   - producto sin precio válido o sin stock
const { getConcept } = require("./concepts");
const { dimensionConflict } = require("./attributes");
const { EXCLUDE_UNLESS_REQUESTED } = require("../config/matchingRules");

const ALWAYS_CHECKED = ["zurdo"];

function conceptCompatible(req, product) {
  if (!req.concept) return true; // sin concepto no hay categoría que validar (la confianza queda baja)
  if (product.concept === req.concept) return true;
  return (req.alternatives || []).includes(product.concept) || (req.accepted || []).includes(product.concept);
}

function violations(req, product, { checkAvailability = true } = {}) {
  const out = [];
  if (!conceptCompatible(req, product)) out.push({ code: "concept", detail: `${product.concept || "sin categoría"} ≠ ${req.concept}` });

  const conceptDef = getConcept(product.concept) || getConcept(req.concept);
  const dims = new Set([...(conceptDef && conceptDef.dims ? conceptDef.dims : []), ...ALWAYS_CHECKED]);
  for (const dim of dims) {
    if (dim === "hojas") {
      const a = req.attrs.hojas;
      const b = product.attrs.hojas;
      // 96 vs 100 hojas es el mismo producto a efectos escolares; 48 vs 100 no.
      if (a && b && Math.abs(a - b) / Math.max(a, b) > 0.25) out.push({ code: "hojas", detail: `${a} ≠ ${b} hojas` });
      continue;
    }
    if (dim === "zurdo") {
      if (product.attrs.zurdo && !req.attrs.zurdo) out.push({ code: "zurdo", detail: "producto para zurdos" });
      continue;
    }
    if (dim === "cantidadColores" || dim === "largo") continue; // preferencias, no conflictos
    const extra = (conceptDef && conceptDef.compat && conceptDef.compat[dim]) || [];
    if (dimensionConflict(dim, req.attrs[dim], product.attrs[dim], extra)) {
      out.push({ code: dim, detail: `${req.attrs[dim]} ≠ ${product.attrs[dim]}` });
    }
  }

  for (const rule of EXCLUDE_UNLESS_REQUESTED) {
    if (!rule.soft && rule.product.test(product.norm) && !rule.request.test(req.norm)) {
      out.push({ code: "not-requested", detail: rule.product.source });
    }
  }

  if (checkAvailability && !product.sellable) out.push({ code: "unavailable", detail: "sin stock o sin precio" });
  return out;
}

module.exports = { violations, conceptCompatible };
