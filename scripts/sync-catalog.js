#!/usr/bin/env node
// Sincroniza el catálogo y escribe data/catalog.json (snapshot normalizado).
//   node scripts/sync-catalog.js                 → API oficial si hay TIENDANUBE_ACCESS_TOKEN, si no tienda pública
//   node scripts/sync-catalog.js --source=storefront
// El servidor recarga el snapshot en caliente (CATALOG_RELOAD_MS), no hace falta reiniciar.
const fs = require("fs");
const path = require("path");
const config = require("../src/config");
const { fetchStorefrontCatalog } = require("../src/catalog/providers/storefront");
const { fetchTiendanubeCatalog } = require("../src/catalog/providers/tiendanubeApi");

async function main() {
  const arg = (process.argv.find((a) => a.startsWith("--source=")) || "").split("=")[1];
  const source = arg || (config.catalog.tiendanubeToken ? "tiendanube-api" : "storefront");
  const started = Date.now();
  console.log(`Sincronizando catálogo desde ${source}…`);

  const products =
    source === "tiendanube-api"
      ? await fetchTiendanubeCatalog({
          storeId: config.catalog.tiendanubeStoreId,
          token: config.catalog.tiendanubeToken,
          storeBaseUrl: config.catalog.storeBaseUrl,
        })
      : await fetchStorefrontCatalog({
          baseUrl: config.catalog.storeBaseUrl,
          onPage: (page, n) => process.stdout.write(`  página ${page}: ${n} productos\r`),
        });

  // Una tienda vacía o una página de error no deben pisar un catálogo bueno.
  if (products.length < 100) throw new Error(`Sólo ${products.length} productos: no se escribe el snapshot`);

  const out = config.catalog.snapshotPath;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = out + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ meta: { source, syncedAt: new Date().toISOString(), count: products.length }, products }));
  fs.renameSync(tmp, out); // escritura atómica: el servidor nunca lee un archivo a medias
  const available = products.filter((p) => p.available).length;
  console.log(`\n${products.length} productos (${available} disponibles) → ${out} en ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

main().catch((e) => {
  console.error("Sync falló:", e.message);
  process.exit(1);
});
