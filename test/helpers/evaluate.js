// Evalúa casos del dataset (test/fixtures/matching-cases.json) contra el motor y calcula métricas.
const { normalize } = require("../../src/matching/text");

const SELECTED = new Set(["matched", "review"]);

function checkCase(c, r) {
  const e = c.expect || {};
  const errors = [];
  const selected = SELECTED.has(r.status);
  const name = r.product ? normalize(r.product.name) : "";
  const wantsSelection = Boolean(e.sku || e.nameMatch || e.concept || e.variant || e.packs) && (!e.status || ["review", "matched"].includes(e.status));

  if (e.status && r.status !== e.status) errors.push(`status ${r.status} ≠ ${e.status}`);
  if (e.notSelected && selected) errors.push(`seleccionó "${r.product.name}" y no debía`);
  if (wantsSelection && !selected) errors.push(`no seleccionó nada (${r.status}${r.reason ? ": " + r.reason : ""})`);

  if (selected) {
    if (e.sku) {
      const skus = Array.isArray(e.sku) ? e.sku : [e.sku];
      // El SKU esperado puede ser el del producto o el de la variante elegida.
      if (!skus.includes(r.product.sku) && !skus.includes(r.product.productSku)) {
        errors.push(`sku ${r.product.productSku}/${r.product.sku} (${r.product.name}) ∉ [${skus}]`);
      }
    }
    const concepts = e.concept ? (Array.isArray(e.concept) ? e.concept : [e.concept]) : null;
    if (concepts && !concepts.includes(r.product.concept)) errors.push(`concepto ${r.product.concept} ∉ [${concepts}] (${r.product.name})`);
    if (e.mustNotConcept && r.product.concept === e.mustNotConcept) errors.push(`concepto prohibido ${e.mustNotConcept} (${r.product.name})`);
    if (e.nameMatch && !new RegExp(e.nameMatch).test(name)) errors.push(`"${r.product.name}" no matchea /${e.nameMatch}/`);
    if (e.mustNot && new RegExp(e.mustNot).test(name)) errors.push(`"${r.product.name}" matchea lo prohibido /${e.mustNot}/`);
    if (e.packs !== undefined && r.packs !== e.packs) errors.push(`packs ${r.packs} ≠ ${e.packs}`);
    if (e.variant && !new RegExp(`\\b${e.variant}`).test(normalize(r.product.variantLabel || ""))) {
      errors.push(`variante "${r.product.variantLabel}" no matchea ${e.variant}`);
    }
    if (e.rayado && r.product.attrs && r.product.attrs.rayado !== e.rayado) errors.push(`rayado ${r.product.attrs.rayado} ≠ ${e.rayado}`);
  }

  // Falso positivo: seleccionó automáticamente algo incorrecto (o algo cuando no debía).
  const falsePositive = selected && errors.length > 0 && !errors.every((x) => x.startsWith("packs") || x.startsWith("variante"));
  return { ok: errors.length === 0, errors, selected, falsePositive };
}

function evaluate(cases, matchFn) {
  const results = cases.map((c) => {
    const r = matchFn(c.input);
    return { case: c, result: r, ...checkCase(c, r) };
  });
  const selectable = results.filter((x) => !x.case.expect.status && !x.case.expect.notSelected);
  const selected = results.filter((x) => x.selected);
  const metrics = {
    cases: results.length,
    passed: results.filter((x) => x.ok).length,
    // De lo que el motor eligió solo, qué porcentaje es correcto.
    precision: selected.length ? selected.filter((x) => !x.falsePositive).length / selected.length : 1,
    // De lo que debería encontrarse, qué porcentaje encontró.
    coverage: selectable.length ? selectable.filter((x) => x.selected).length / selectable.length : 1,
    falsePositiveRate: results.filter((x) => x.falsePositive).length / results.length,
    // Ítems que la familia tendría que revisar (confianza media o baja).
    reviewRate: results.filter((x) => ["review", "suggested"].includes(x.result.status)).length / results.length,
  };
  return { results, metrics };
}

module.exports = { evaluate, checkCase };
