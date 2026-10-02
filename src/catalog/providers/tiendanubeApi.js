// Catálogo desde la API oficial de Tiendanube (recomendado cuando haya token).
// Docs: https://tiendanube.github.io/api-documentation/intro
//   Base: https://api.tiendanube.com/2025-03/{store_id}
//   Headers: "Authorization: Bearer <token>" + "User-Agent: <app> (<email o url>)" (obligatorio, si falta → 400)
//   Paginación: per_page máx. 200, seguir el header Link rel="next".
//   Rate limit: bucket de 40 requests, 2 por segundo.
// El token se obtiene creando una app para la tienda en el panel de socios de Tiendanube.

const API_VERSION = "2025-03";

function nextLink(linkHeader) {
  const m = String(linkHeader || "").match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

const pickLang = (v) => (v && typeof v === "object" ? v.es || v.pt || Object.values(v)[0] : v) || "";

function mapProduct(p, storeBaseUrl) {
  const handle = pickLang(p.handle);
  const imagesById = new Map((p.images || []).map((i) => [i.id, i.src]));
  const variants = (p.variants || []).map((v) => ({
    id: v.id,
    sku: v.sku ? String(v.sku).trim() : null,
    price: v.promotional_price ? Number(v.promotional_price) : Number(v.price),
    stock: v.stock_management === false || v.stock === null ? null : Number(v.stock),
    available: v.stock_management === false || v.stock === null || Number(v.stock) > 0,
    options: (v.values || []).map(pickLang).filter(Boolean),
    imageUrl: imagesById.get(v.image_id) || null,
    contactOnly: false,
  }));
  const sellable = variants.filter((v) => v.available && Number.isFinite(v.price));
  const main = sellable[0] || variants[0] || {};
  const stocks = variants.map((v) => v.stock);
  return {
    id: String(p.id),
    productId: p.id,
    sku: main.sku || null,
    name: pickLang(p.name).trim(),
    slug: handle || null,
    url: handle ? `${storeBaseUrl}/productos/${handle}/` : null,
    price: sellable.length ? Math.min(...sellable.map((v) => v.price)) : Number(main.price) || 0,
    stock: stocks.some((s) => s === null) ? null : stocks.reduce((a, b) => a + b, 0),
    available: p.published !== false && sellable.length > 0,
    imageUrl: (p.images && p.images[0] && p.images[0].src) || null,
    brand: p.brand || null,
    categories: (p.categories || []).map((c) => pickLang(c.name)).filter(Boolean),
    variants,
    source: "tiendanube-api",
  };
}

async function fetchTiendanubeCatalog({ storeId, token, storeBaseUrl, userAgent, fetchImpl = fetch } = {}) {
  if (!storeId || !token) throw new Error("Faltan TIENDANUBE_STORE_ID / TIENDANUBE_ACCESS_TOKEN");
  let url = `https://api.tiendanube.com/${API_VERSION}/${storeId}/products?per_page=200&published=true`;
  const out = [];
  while (url) {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent || "LermaPresupuestador (librerialerma.com.ar)" },
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (!res.ok) throw new Error(`Tiendanube API HTTP ${res.status}`);
    const page = await res.json();
    for (const p of page) out.push(mapProduct(p, storeBaseUrl));
    url = nextLink(res.headers.get("link"));
  }
  return out;
}

module.exports = { fetchTiendanubeCatalog, mapProduct, nextLink };
