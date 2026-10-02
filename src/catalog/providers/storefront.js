// Catálogo desde la tienda pública de Tiendanube, sin credenciales.
// GET /productos/page/N/?results_only=true devuelve el HTML de 12 productos por página; cada producto
// trae data-variants con product_id, id de variante, SKU, precio, stock, disponibilidad e imagen.
// Es la fuente que usa scripts/sync-catalog.js mientras no haya token de la API oficial.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", aacute: "á", eacute: "é",
  iacute: "í", oacute: "ó", uacute: "ú", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü", deg: "°", ordm: "º", ordf: "ª" };

function decodeEntities(s) {
  return String(s || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
  });
}

const absUrl = (u) => (!u ? null : u.startsWith("//") ? "https:" + u : u);

// Imagen en tamaño útil para la UI (Tiendanube sirve -50-0, -240-0, -480-0, -1024-1024…).
const resizeImage = (u, size = 480) => (u ? u.replace(/-(\d+)-(\d+)\.(webp|jpg|jpeg|png)$/i, `-${size}-0.$3`) : null);

function parseListingHtml(html) {
  const chunks = String(html).split(/(?=<div class="js-item-product)/).slice(1);
  const products = [];
  for (const chunk of chunks) {
    const id = (chunk.match(/data-product-id="(\d+)"/) || [])[1];
    const variantsRaw = (chunk.match(/data-variants="([^"]*)"/) || [])[1];
    if (!id || !variantsRaw) continue;
    let variants;
    try {
      variants = JSON.parse(decodeEntities(variantsRaw));
    } catch {
      continue;
    }
    const href = (chunk.match(/href="([^"]*\/productos\/[^"]+)"/) || [])[1] || null;
    const nameRaw = (chunk.match(/js-item-name[^>]*>\s*([^<]+)</) || chunk.match(/title="([^"]+)"/) || [])[1] || "";
    const imgRaw = (chunk.match(/data-srcset="([^" ,]+)/) || chunk.match(/src="([^"]*mitiendanube[^"]+)"/) || [])[1];
    const slug = href ? (href.match(/\/productos\/([^/?#]+)/) || [])[1] || null : null;

    const vs = variants.map((v) => ({
      id: v.id,
      sku: v.sku ? String(v.sku).trim() : null,
      price: typeof v.price_number === "number" ? v.price_number : null,
      stock: typeof v.stock === "number" ? v.stock : null, // null = stock sin control
      available: v.available !== false && v.is_visible !== false,
      options: [v.option0, v.option1, v.option2].filter((o) => o !== null && o !== undefined && o !== ""),
      imageUrl: resizeImage(absUrl(v.image_url)),
      contactOnly: !!v.contact,
    }));
    const sellable = vs.filter((v) => v.available && v.price !== null);
    const main = sellable[0] || vs[0];
    if (!main) continue;
    const stocks = vs.map((v) => v.stock);
    products.push({
      id: String(id),
      productId: Number(id),
      sku: main.sku,
      name: decodeEntities(nameRaw).replace(/\s+/g, " ").trim(),
      slug,
      url: href ? absUrl(href) : null,
      // Precio de referencia: el de la variante más barata disponible.
      price: sellable.length ? Math.min(...sellable.map((v) => v.price)) : main.price,
      stock: stocks.some((s) => s === null) ? null : stocks.reduce((a, b) => a + b, 0),
      available: sellable.length > 0,
      imageUrl: resizeImage(absUrl(imgRaw)) || main.imageUrl,
      brand: null,
      categories: [],
      variants: vs,
      source: "storefront",
    });
  }
  return products;
}

async function fetchStorefrontCatalog({ baseUrl, delayMs = 700, maxPages = 400, fetchImpl = fetch, onPage } = {}) {
  const all = new Map();
  for (let page = 1; page <= maxPages; page++) {
    const url = `${baseUrl}/productos/page/${page}/?results_only=true`;
    let html = null;
    for (let attempt = 1; attempt <= 3 && html === null; attempt++) {
      try {
        const res = await fetchImpl(url, { headers: { "User-Agent": "LermaPresupuestador-CatalogSync/1.0" } });
        if (res.ok) html = await res.text();
        else if (res.status === 404) html = "";
        else throw new Error("HTTP " + res.status);
      } catch (e) {
        if (attempt === 3) throw new Error(`Página ${page}: ${e.message}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    const items = parseListingHtml(html);
    if (onPage) onPage(page, items.length);
    if (items.length === 0) break;
    for (const p of items) all.set(p.id, p);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return [...all.values()];
}

module.exports = { fetchStorefrontCatalog, parseListingHtml, decodeEntities, resizeImage };
