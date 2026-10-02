// Cantidad pedida vs. cantidad comercial.
//   "20 folios" + producto "Folios A4 LUMA" con variantes x10 y x100 → 2 paquetes x10 (más barato que 1 x100)
//   "2 cajas de lápices de colores x12" → 2 cajas
//   "10 plastilinas" + "Plastilina X10" → 1 paquete

// Variante que mejor coincide con lo pedido (color, tamaño, número, formato). Devuelve [{variant, fit}] ordenado.
const { detectColors } = require("./attributes");

function rankVariants(product, req) {
  const want = [];
  const wantColors = req.attrs.colors || [];
  if (req.attrs.formato) want.push(req.attrs.formato, req.attrs.formato.replace(/^n(\d)$/, "$1"));
  if (req.attrs.grosor) want.push(req.attrs.grosor);
  if (req.attrs.punta) want.push(req.attrs.punta);
  if (req.attrs.mina) want.push(req.attrs.mina);
  if (req.attrs.rayado) want.push(req.attrs.rayado);
  if (req.attrs.tipoMapa) want.push(req.attrs.tipoMapa);
  const num = req.norm.match(/\bn(\d{1,2})\b/);
  if (num) want.push("n" + num[1]);

  return product.variants
    .filter((v) => v.sellable)
    .map((v) => {
      let fit = 0;
      if (wantColors.length) {
        const have = detectColors(v.optionsNorm);
        fit += wantColors.filter((c) => have.includes(c)).length;
      }
      for (const w of want) {
        const safe = String(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (w && new RegExp(`\\b${safe}(e?s|as|os)?\\b`).test(v.optionsNorm)) fit++;
      }
      // "oficio" vs "a4" en la opción: conflicto explícito
      if (req.attrs.formato === "a4" && /\boficio\b/.test(v.optionsNorm)) fit -= 5;
      if (req.attrs.formato === "oficio" && /\ba4\b/.test(v.optionsNorm)) fit -= 5;
      return { variant: v, fit };
    })
    .sort((a, b) => b.fit - a.fit);
}

// Palabras con las que un pedido cuenta unidades sueltas de un concepto ("12 fibrones", "20 folios").
function unitWordsOf(conceptDef) {
  return conceptDef.unitWords || (conceptDef.packUnit ? [conceptDef.packUnit] : []);
}

function plural(word, n) {
  if (n === 1) return word;
  if (/z$/.test(word)) return word.slice(0, -1) + "ces";
  if (/[aeiou]$/.test(word)) return word + "s";
  return word + "es";
}

function packsFor(req, unitsPerPack, conceptDef) {
  const qty = req.quantity;
  const a = req.attrs;
  // El pedido ya habla en envases ("2 cajas", "1 paquete", "3 blocks").
  if (a.container) return { packs: qty, mode: "container" };
  if (!conceptDef || !conceptDef.packUnit) return { packs: qty, mode: "unit" };
  // "2 repuestos" cuenta repuestos (paquetes), no hojas: sólo convertir si el pedido cuenta unidades del concepto.
  const countsUnits = !req.quantityWasExplicit || !a.unitWord || unitWordsOf(conceptDef).includes(a.unitWord);
  if (!countsUnits) return { packs: qty, mode: "unit" };
  // "20 hojas canson" y el paquete no dice cuántas hojas trae: no multiplicar a ciegas.
  if (unitsPerPack == null && conceptDef.packSizeRequired) return { packs: 1, mode: qty > 1 ? "unknown-pack-size" : "unit" };
  if (!unitsPerPack || unitsPerPack <= 1) return { packs: qty, mode: "unit" };
  // "lápices de colores x12" sin cantidad delante: es 1 paquete de 12.
  if (!req.quantityWasExplicit && a.contentCount) return { packs: 1, mode: "pack-descriptor" };
  // Cantidad chica + producto en paquete grande: si el pedido no dice unidades ("2 fibras x12"), son paquetes.
  if (a.contentCount && a.contentCount === unitsPerPack) return { packs: qty, mode: "packs-of-requested-size" };
  // Unidades sueltas: "20 folios" → ceil(20 / 10)
  return { packs: Math.ceil(qty / unitsPerPack), mode: "units-to-packs" };
}

// Elige variante y cantidad de paquetes minimizando el costo entre las variantes que mejor coinciden.
function chooseVariantAndQuantity(product, req, conceptDef) {
  const ranked = rankVariants(product, req);
  if (!ranked.length) return null;
  const bestFit = ranked[0].fit;
  const options = ranked
    .filter((r) => r.fit === bestFit)
    .map(({ variant }) => {
      const { packs, mode } = packsFor(req, variant.unitsPerPack, conceptDef);
      return { variant, packs, mode, cost: packs * variant.price };
    })
    .sort((x, y) => x.cost - y.cost || x.packs - y.packs);
  const best = options[0];
  let note = null;
  if (best.mode === "unknown-pack-size") note = `Revisá la cantidad: pediste ${req.quantity} ${plural(conceptDef.packUnit, req.quantity)} y no sabemos cuántas trae cada paquete.`;
  if (best.mode === "units-to-packs" && best.variant.unitsPerPack > 1 && req.quantityWasExplicit && req.quantity > 1) {
    note = `${req.quantity} ${plural(conceptDef.packUnit, req.quantity)} → ${best.packs} ${plural("paquete", best.packs)} x${best.variant.unitsPerPack}`;
  }
  return { variant: best.variant, packs: best.packs, unitsPerPack: best.variant.unitsPerPack || 1, quantityMode: best.mode, quantityNote: note, variantFit: bestFit };
}

module.exports = { chooseVariantAndQuantity, packsFor, rankVariants };
