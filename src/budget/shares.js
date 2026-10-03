// Presupuestos compartibles: /presupuesto/:id (o la página de la tienda con ?p=).
// Se guarda sólo lo que la familia eligió: texto de cada ítem, producto, variante y cantidades. Nunca el archivo
// original. Al abrir el link los precios y el stock se recalculan con el catálogo del momento.
//
// Con base de datos: id corto aleatorio (8 caracteres). Sin base: el presupuesto viaja comprimido en el propio
// link ("z…"), así los links funcionan aunque el servidor se reinicie.
const crypto = require("crypto");
const zlib = require("zlib");
const config = require("../config");
const { getStorage } = require("../storage");
const { store } = require("../catalog/catalogStore");
const { matchLines } = require("./budgetService");

const MAX_LINES = 150;
const ID_RE = /^[A-Za-z0-9_-]{8}$/;
const TOKEN_RE = /^z[A-Za-z0-9_-]{8,6000}$/;

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : v == null ? undefined : String(v).slice(0, max));
const int = (v, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : undefined;
};

// Sólo los campos conocidos, con largos y rangos acotados. Lo que no se reconoce se descarta.
function sanitizeLines(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, MAX_LINES).map((l) => {
    if (!l || typeof l !== "object") return null;
    const text = str(l.text, 200);
    if (!text || !text.trim()) return null;
    const out = { text: text.trim() };
    const quantity = int(l.quantity, 1, 999);
    if (quantity) out.quantity = quantity;
    if (l.productId != null && store.get(String(l.productId))) {
      out.productId = String(l.productId);
      if (l.variantId != null) out.variantId = str(l.variantId, 20);
      const packs = int(l.packs, 1, 999);
      if (packs) out.packs = packs;
    }
    const grade = str(l.grade, 40);
    if (grade) out.grade = grade;
    if (l.optional) out.optional = true;
    if (l.optIn) out.optIn = true;
    const note = str(l.note, 120);
    if (note) out.note = note;
    return out;
  }).filter(Boolean);
}

// Formato compacto para el link autocontenido.
const KEYS = { text: "t", quantity: "q", productId: "p", variantId: "v", packs: "k", grade: "g", optional: "o", optIn: "i", note: "n" };
const UNKEYS = Object.fromEntries(Object.entries(KEYS).map(([a, b]) => [b, a]));

function encodeToken(lines) {
  const compact = lines.map((l) => Object.fromEntries(Object.entries(l).map(([k, v]) => [KEYS[k], v === true ? 1 : v])));
  return "z" + zlib.deflateRawSync(Buffer.from(JSON.stringify(compact)), { level: 9 }).toString("base64url");
}

function decodeToken(token) {
  try {
    // maxOutputLength: un link manipulado no puede inflarse a megas.
    const json = zlib.inflateRawSync(Buffer.from(token.slice(1), "base64url"), { maxOutputLength: 200000 }).toString("utf8");
    const compact = JSON.parse(json);
    if (!Array.isArray(compact)) return null;
    return sanitizeLines(compact.map((c) => (c && typeof c === "object" ? Object.fromEntries(Object.entries(c).map(([k, v]) => [UNKEYS[k] || "_", v])) : null)));
  } catch {
    return null;
  }
}

const shareUrl = (id) => config.data.shareBaseUrl + encodeURIComponent(id);

async function createShare(rawLines) {
  const lines = sanitizeLines(rawLines);
  if (!lines.length) return null;
  const storage = getStorage();
  if (!storage.persistent) {
    const id = encodeToken(lines);
    return { id, url: shareUrl(id), persistent: false };
  }
  const id = crypto.randomBytes(6).toString("base64url");
  const expiresAt = new Date(Date.now() + config.data.shareDays * 86400000);
  await storage.saveBudget({ id, lines, expiresAt });
  return { id, url: shareUrl(id), persistent: true, expiresAt: expiresAt.toISOString() };
}

const isShareId = (id) => ID_RE.test(id) || TOKEN_RE.test(id);

async function loadShare(id) {
  if (TOKEN_RE.test(id)) return decodeToken(id);
  if (!ID_RE.test(id)) return null;
  const saved = await getStorage().getBudget(id);
  return saved ? sanitizeLines(saved.lines) : null;
}

// Rearma el presupuesto completo (con alternativas, estados y precios de hoy) a partir de las líneas guardadas.
function restoreBudget(id, lines) {
  const { items, summary } = matchLines(lines.map((l, i) => ({ ...l, lineId: i + 1 })));
  const grades = [...new Set(items.map((i) => i.grade).filter(Boolean))];
  const warnings = [];
  const lost = lines.filter((l, i) => l.productId && items[i].product && String(items[i].product.id) !== l.productId).length;
  if (lost) warnings.push(`${lost === 1 ? "Un producto elegido ya no está disponible" : `${lost} productos elegidos ya no están disponibles`}: te sugerimos ${lost === 1 ? "otro" : "otros"}.`);
  return {
    success: true,
    id: id.length <= 12 ? id : crypto.createHash("sha256").update(id).digest("hex").slice(0, 10).toUpperCase(),
    shareId: id,
    createdAt: new Date().toISOString(),
    summary, items, grades, warnings,
    catalog: { syncedAt: store.meta.syncedAt || null, source: store.meta.source || null },
    meta: { restored: true },
  };
}

module.exports = { createShare, loadShare, restoreBudget, sanitizeLines, encodeToken, decodeToken, isShareId, shareUrl };
