#!/usr/bin/env node
// Métricas del motor sobre los datasets:
//   - matching-cases.json: regresión (todas las reglas del sistema anterior + trampas conocidas)
//   - holdout-cases.json:  líneas reales de listas escritas ANTES de correr el motor (no se ajustan a mano)
//   node scripts/eval-matching.js           → resumen + casos fallidos
//   node scripts/eval-matching.js --all     → todos los casos
process.env.NODE_ENV = process.env.NODE_ENV || "test";
const { store } = require("../src/catalog/catalogStore");
const { matchItem } = require("../src/matching/engine");
const { evaluate } = require("../test/helpers/evaluate");

store.loadFromDisk();
const all = process.argv.includes("--all");
const pct = (x) => (x * 100).toFixed(1) + "%";
let failed = 0;

for (const [label, file] of [["Regresión", "matching-cases.json"], ["Holdout", "holdout-cases.json"]]) {
  const cases = require("../test/fixtures/" + file);
  const started = process.hrtime.bigint();
  const { results, metrics } = evaluate(cases, (input) => matchItem(input, store));
  const ms = Number((process.hrtime.bigint() - started) / 1000000n);
  console.log(`\n── ${label} (${file})`);
  for (const r of results) {
    if (!all && r.ok) continue;
    const p = r.result.product;
    const got = p ? `${p.name}${p.variantLabel ? " [" + p.variantLabel + "]" : ""} x${r.result.packs}` : r.result.inStore ? "SUCURSAL" : r.result.reason || "";
    console.log(`${r.ok ? "✔" : "✘"} ${r.case.input.padEnd(50)} ${(r.result.status + "/" + (r.result.confidence || "-")).padEnd(18)} ${got}`);
    for (const e of r.errors) console.log("      " + e);
  }
  failed += metrics.cases - metrics.passed;
  console.log(`${metrics.passed}/${metrics.cases} OK · precisión ${pct(metrics.precision)} · cobertura ${pct(metrics.coverage)} · falsos positivos ${pct(metrics.falsePositiveRate)} · a revisar ${pct(metrics.reviewRate)} · ${(ms / metrics.cases).toFixed(1)} ms/ítem`);
}
process.exitCode = failed ? 1 : 0;
