// Sincronización del catálogo desde la tienda (API oficial o tienda pública).
// La usan el script (npm run sync-catalog) y el servidor, que se sincroniza solo cada CATALOG_SYNC_HOURS:
// precios y stock al día sin redeploy. Si algo falla, el catálogo anterior sigue en uso.
const fs = require("fs");
const path = require("path");
const config = require("../config");
const { fetchStorefrontCatalog } = require("./providers/storefront");
const { fetchTiendanubeCatalog } = require("./providers/tiendanubeApi");
const { logger } = require("../observability/logger");

const status = { running: false, lastAttemptAt: null, lastSuccessAt: null, lastError: null, lastCount: null, lastMs: null, failuresInARow: 0 };

class SyncRejected extends Error {}

// Un catálogo que se achica de golpe es casi siempre un error de la tienda (página caída, filtro), no la realidad.
function validate(products, currentCount) {
  if (products.length < 100) throw new SyncRejected(`Sólo ${products.length} productos`);
  if (currentCount >= 100 && products.length < currentCount * config.catalog.minSyncRatio) {
    throw new SyncRejected(`${products.length} productos contra ${currentCount} actuales (cayó más de lo permitido)`);
  }
}

function writeSnapshot(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file); // atómico: nunca se lee un archivo a medias
}

async function fetchProducts(source, onPage) {
  if (source === "tiendanube-api") {
    return fetchTiendanubeCatalog({ storeId: config.catalog.tiendanubeStoreId, token: config.catalog.tiendanubeToken, storeBaseUrl: config.catalog.storeBaseUrl });
  }
  return fetchStorefrontCatalog({ baseUrl: config.catalog.storeBaseUrl, onPage });
}

// store: si se pasa, el catálogo nuevo se carga en memoria al terminar.
async function syncCatalog({ source, store = null, currentCount = store ? store.products.length : 0, onPage, fetcher = fetchProducts } = {}) {
  if (status.running) return { skipped: true };
  source = source || (config.catalog.tiendanubeToken ? "tiendanube-api" : "storefront");
  const started = Date.now();
  Object.assign(status, { running: true, lastAttemptAt: new Date().toISOString() });
  try {
    const products = await fetcher(source, onPage);
    validate(products, currentCount);
    const meta = { source, syncedAt: new Date().toISOString(), count: products.length };
    const file = config.catalog.snapshotPath;
    try {
      writeSnapshot(file, { meta, products });
    } catch (e) {
      // Sin disco escribible igual se usa en memoria.
      logger.warn("catalog_snapshot_write_failed", { message: e.message });
    }
    if (store) {
      store.load(products, { ...meta, path: file });
      try { store.mtimeMs = fs.statSync(file).mtimeMs; } catch {}
    }
    Object.assign(status, { lastSuccessAt: meta.syncedAt, lastError: null, lastCount: products.length, lastMs: Date.now() - started, failuresInARow: 0 });
    logger.info("catalog_synced", { source, products: products.length, available: products.filter((p) => p.available).length, ms: status.lastMs });
    return { products, meta };
  } catch (e) {
    status.failuresInARow++;
    status.lastError = e.message;
    // Varios fallos seguidos: queda en el log como error (alerta en Render) y en /api/health.
    logger[status.failuresInARow >= 3 ? "error" : "warn"]("catalog_sync_failed", { source, message: e.message, failuresInARow: status.failuresInARow });
    throw e;
  } finally {
    status.running = false;
  }
}

// Sincroniza cada `hours`. Al arrancar, si el snapshot es más viejo que el intervalo, sincroniza enseguida
// (Render free reinicia seguido y arranca con el snapshot del repo).
function startScheduledSync(store, hours = config.catalog.syncHours) {
  if (!hours) return null;
  const ms = hours * 3600 * 1000;
  const run = () => syncCatalog({ store }).catch(() => {});
  const syncedAt = Date.parse(store.meta.syncedAt || 0) || 0;
  const firstIn = Date.now() - syncedAt > ms ? config.catalog.syncStartDelayMs : ms - (Date.now() - syncedAt);
  const first = setTimeout(() => {
    run();
    const timer = setInterval(run, ms);
    timer.unref();
  }, Math.max(0, firstIn));
  first.unref();
  return first;
}

const syncStatus = () => ({ ...status });

module.exports = { syncCatalog, startScheduledSync, syncStatus, validate, SyncRejected };
