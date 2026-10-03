#!/usr/bin/env node
// Sincroniza el catálogo y escribe data/catalog.json (snapshot normalizado).
//   node scripts/sync-catalog.js                 → API oficial si hay TIENDANUBE_ACCESS_TOKEN, si no tienda pública
//   node scripts/sync-catalog.js --source=storefront
//   node scripts/sync-catalog.js --force         → acepta aunque el catálogo se achique mucho
// El servidor además se sincroniza solo cada CATALOG_SYNC_HOURS (ver src/catalog/syncService.js).
const config = require("../src/config");
const { syncCatalog } = require("../src/catalog/syncService");
const { loadCatalogFile } = require("../src/catalog/providers/jsonFile");

async function main() {
  const source = (process.argv.find((a) => a.startsWith("--source=")) || "").split("=")[1] || undefined;
  let currentCount = 0;
  if (!process.argv.includes("--force")) {
    try { currentCount = loadCatalogFile(config.catalog).products.length; } catch {}
  }
  const started = Date.now();
  console.log(`Sincronizando catálogo desde ${source || "la fuente por defecto"}…`);
  const { products } = await syncCatalog({ source, currentCount, onPage: (page, n) => process.stdout.write(`  página ${page}: ${n} productos\r`) });
  const available = products.filter((p) => p.available).length;
  console.log(`\n${products.length} productos (${available} disponibles) → ${config.catalog.snapshotPath} en ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

main().catch((e) => {
  console.error("Sync falló:", e.message);
  process.exit(1);
});
