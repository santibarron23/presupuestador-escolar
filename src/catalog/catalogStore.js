// Catálogo en memoria: productos enriquecidos (concepto, atributos, unidades por paquete) + índice BM25.
// Se recarga en caliente cuando cambia el snapshot (scripts/sync-catalog.js).
const fs = require("fs");
const config = require("../config");
const { loadCatalogFile } = require("./providers/jsonFile");
const { normalize, tokenize } = require("../matching/text");
const { classifyProduct } = require("../matching/concepts");
const { extractAttributes } = require("../matching/attributes");
const { UNITS_PER_PACK } = require("../config/matchingRules");
const { logger } = require("../observability/logger");

const BM25_K1 = 1.2;
const BM25_B = 0.6;

function unitsPerPackFrom(text) {
  const t = normalize(text);
  const m = t.match(/\bx(\d{1,4})\s?(u|un|uds?|unid|unidades|pz|pzs|piezas|hojas?|h)?\b/) ||
    t.match(/\b(?:pack|paquete|caja|blister) (?:de |x)?(\d{1,4})\b/) ||
    t.match(/\b(\d{1,4})\s?(u|unidades|uds)\b/) ||
    t.match(/\b(\d{2,4})\s?(h|hs|hojas)\b/);
  return m ? Number(m[1]) : null;
}

function enrich(p, minValidPrice) {
  const norm = normalize(p.name);
  const nameUnits = UNITS_PER_PACK[p.sku] || unitsPerPackFrom(p.name);
  const variants = (p.variants && p.variants.length ? p.variants : [{
    id: null, sku: p.sku, price: p.price, stock: p.stock, available: p.available, options: [], imageUrl: p.imageUrl,
  }]).map((v) => {
    const optText = (v.options || []).join(" ");
    return {
      ...v,
      optionsNorm: normalize(optText),
      // null = no sabemos cuántas unidades trae (distinto de 1)
      unitsPerPack: unitsPerPackFrom(optText) || nameUnits || null,
      sellable: v.available !== false && typeof v.price === "number" && v.price >= minValidPrice,
    };
  });
  return {
    ...p,
    norm,
    tokens: tokenize(p.name),
    concept: classifyProduct(norm),
    attrs: extractAttributes(norm),
    variants,
    sellable: variants.some((v) => v.sellable),
  };
}

class CatalogStore {
  constructor() {
    this.products = [];
    this.meta = {};
    this.mtimeMs = 0;
  }

  load(products, meta = {}) {
    const minValidPrice = config.catalog.minValidPrice;
    this.products = products.map((p) => enrich(p, minValidPrice));
    this.meta = meta;
    this.byId = new Map(this.products.map((p) => [String(p.id), p]));
    this.bySku = new Map();
    for (const p of this.products) {
      for (const sku of new Set([p.sku, ...p.variants.map((v) => v.sku)].filter(Boolean))) {
        const key = String(sku).trim();
        if (!this.bySku.has(key)) this.bySku.set(key, []);
        this.bySku.get(key).push(p);
      }
    }
    this.byConcept = new Map();
    for (const p of this.products) {
      if (!p.concept) continue;
      if (!this.byConcept.has(p.concept)) this.byConcept.set(p.concept, []);
      this.byConcept.get(p.concept).push(p);
    }
    // BM25
    this.df = new Map();
    let totalLen = 0;
    for (const p of this.products) {
      totalLen += p.tokens.length;
      for (const t of new Set(p.tokens)) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.avgLen = totalLen / Math.max(1, this.products.length);
    this.vocabulary = [...this.df.keys()];
    // Palabras tal como aparecen en los nombres (sin singularizar): base para corregir tipeos.
    this.wordSet = new Set(this.products.flatMap((p) => p.norm.split(" ")).filter((w) => w.length >= 3));
    return this;
  }

  loadFromDisk() {
    const { products, meta } = loadCatalogFile(config.catalog);
    this.load(products, meta);
    try {
      this.mtimeMs = fs.statSync(meta.path).mtimeMs;
    } catch {
      this.mtimeMs = 0;
    }
    logger.info("catalog_loaded", { source: meta.source, syncedAt: meta.syncedAt || null, products: this.products.length,
      sellable: this.products.filter((p) => p.sellable).length, classified: this.products.filter((p) => p.concept).length });
    return this;
  }

  // Recarga si el archivo cambió. Un snapshot corrupto no reemplaza al catálogo bueno en memoria.
  reloadIfChanged() {
    try {
      const path = this.meta.path;
      if (!path) return false;
      const m = fs.statSync(path).mtimeMs;
      if (m === this.mtimeMs) return false;
      this.loadFromDisk();
      return true;
    } catch (e) {
      logger.error("catalog_reload_failed", { message: e.message });
      return false;
    }
  }

  startAutoReload(intervalMs) {
    if (!intervalMs) return;
    this.timer = setInterval(() => this.reloadIfChanged(), intervalMs);
    this.timer.unref();
  }

  idf(term) {
    const n = this.products.length;
    const df = this.df.get(term) || 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  bm25(product, queryTokens) {
    let score = 0;
    const len = product.tokens.length;
    for (const q of new Set(queryTokens)) {
      let tf = 0;
      for (const t of product.tokens) if (t === q) tf++;
      if (!tf) continue;
      score += this.idf(q) * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * len) / this.avgLen)));
    }
    return score;
  }

  // Búsqueda libre (para "buscar otro producto" y para pedidos sin concepto reconocido).
  search(queryTokens, { limit = 20, filter } = {}) {
    const results = [];
    for (const p of this.products) {
      if (filter && !filter(p)) continue;
      const s = this.bm25(p, queryTokens);
      if (s > 0) results.push({ product: p, score: s });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  get(id) {
    return this.byId.get(String(id)) || null;
  }

  findRef(ref) {
    if (!ref) return null;
    const candidates = ref.sku ? this.bySku.get(String(ref.sku).trim()) || [] : this.products;
    if (!ref.name) return candidates[0] || null;
    return candidates.find((p) => ref.name.test(p.norm)) || null;
  }
}

const store = new CatalogStore();

module.exports = { store, CatalogStore, enrich, unitsPerPackFrom };
