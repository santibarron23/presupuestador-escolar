#!/usr/bin/env node
// Uso: node scripts/try-match.js "2 lapices negros" "1 goma"   (o líneas por stdin)
process.env.NODE_ENV = process.env.NODE_ENV || "test";
const { store } = require("../src/catalog/catalogStore");
const { matchItem } = require("../src/matching/engine");
store.loadFromDisk();
const run = (lines) => {
  for (const t of lines.filter((l) => l.trim())) {
    const r = matchItem(t, store);
    const right = r.product
      ? `${r.product.name}${r.product.variantLabel ? " [" + r.product.variantLabel + "]" : ""} x${r.packs} $${r.product.unitPrice}${r.quantityNote ? " (" + r.quantityNote + ")" : ""}`
      : r.inStore ? "SUCURSAL: " + r.inStore.label : r.reason;
    console.log(`${(r.status + "/" + (r.confidence || "-")).padEnd(20)} ${t.padEnd(46)} -> ${right}`);
    if (process.env.ALT && r.alternatives) for (const a of r.alternatives) console.log(" ".repeat(24) + `  · ${a.tag}: ${a.name} $${a.price}`);
  }
};
if (process.argv.length > 2) run(process.argv.slice(2));
else { let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => run(s.split(/\r?\n/))); }
