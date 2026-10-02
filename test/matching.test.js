process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const { store } = require("../src/catalog/catalogStore");
const { matchItem } = require("../src/matching/engine");
const { evaluate } = require("./helpers/evaluate");

store.loadFromDisk();
const match = (t, o) => matchItem(t, store, o);

for (const [label, file] of [["regresión", "matching-cases.json"], ["holdout", "holdout-cases.json"]]) {
  test(`dataset de ${label}: todos los casos y cero falsos positivos`, () => {
    const { results, metrics } = evaluate(require("./fixtures/" + file), (i) => match(i));
    const failures = results.filter((r) => !r.ok).map((r) => `${r.case.input}: ${r.errors.join("; ")}`);
    assert.deepEqual(failures, []);
    assert.equal(metrics.falsePositiveRate, 0);
  });
}

test("nunca confunde categorías incompatibles", () => {
  const pairs = [
    ["1 lápiz negro", /boligrafo|birome|lapicera/],
    ["1 birome azul", /\blapiz\b/],
    ["10 folios", /resma|hoja a4/],
    ["1 resma A4", /folio/],
    ["1 caja de fibras", /pizarra|permanente/],
    ["1 marcador para pizarra", /fibra colou?r/],
  ];
  for (const [input, forbidden] of pairs) {
    const r = match(input);
    if (r.product) assert.doesNotMatch(r.product.name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""), forbidden, input);
  }
});

test("A4 nunca termina en oficio ni rayado en cuadriculado", () => {
  const a4 = match("10 folios A4");
  assert.match(a4.product.variantLabel.toLowerCase(), /a4/);
  const ofi = match("10 folios oficio");
  assert.match(ofi.product.variantLabel.toLowerCase(), /oficio/);
  const ray = match("1 repuesto N3 rayado");
  assert.doesNotMatch(ray.product.name.toLowerCase(), /cuadricul/);
});

test("precio y subtotal salen del catálogo", () => {
  const r = match("2 lápices negros");
  const p = store.get(r.product.id);
  assert.equal(r.product.unitPrice, p.variants.find((v) => v.id === r.product.variantId).price);
});

test("producto inexistente no se inventa", () => {
  for (const input of ["1 cortante de masa", "1 bandeja de telgopor", "1 vaso plástico con nombre"]) {
    const r = match(input);
    assert.ok(!["matched", "review"].includes(r.status), `${input} → ${r.status} ${r.product && r.product.name}`);
  }
});

test("producto forzado por la IA o la familia se respeta y se valida", () => {
  const base = match("1 caja de lápices de colores x12");
  const alt = base.alternatives[0];
  const forced = match("1 caja de lápices de colores x12", { forceProductId: alt.id, decidedBy: "ai" });
  assert.equal(forced.product.id, alt.id);
  assert.equal(forced.decidedBy, "ai");
  // La IA no puede imponer un producto incompatible: se ignora y queda la elección del motor.
  const birome = store.byConcept.get("boligrafo").find((p) => p.sellable);
  const bad = match("1 lápiz negro", { forceProductId: birome.id, decidedBy: "ai" });
  assert.notEqual(bad.product.id, birome.id);
});
