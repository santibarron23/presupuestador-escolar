// Catálogo desde archivo: el snapshot normalizado (data/catalog.json) o el catalog.json legacy.
const fs = require("fs");

// catalog.json original: [{id, name, sku, slug, price, stock, description}]
function mapLegacy(p, storeBaseUrl) {
  return {
    id: "legacy-" + p.id,
    productId: null,
    sku: p.sku ? String(p.sku).trim() : null,
    name: String(p.name || "").trim(),
    slug: p.slug || null,
    url: p.slug ? `${storeBaseUrl}/productos/${p.slug}/` : null,
    price: Number(p.price) || 0,
    stock: typeof p.stock === "number" ? p.stock : null,
    available: typeof p.stock === "number" ? p.stock > 0 : true,
    imageUrl: null,
    brand: null,
    categories: [],
    variants: [],
    source: "legacy-json",
  };
}

function loadCatalogFile({ snapshotPath, legacyPath, storeBaseUrl }) {
  if (snapshotPath && fs.existsSync(snapshotPath)) {
    const data = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    return { products: data.products, meta: { ...data.meta, path: snapshotPath } };
  }
  const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
  return {
    products: legacy.map((p) => mapLegacy(p, storeBaseUrl)),
    meta: { source: "legacy-json", syncedAt: null, path: legacyPath },
  };
}

module.exports = { loadCatalogFile, mapLegacy };
