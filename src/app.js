// Aplicación HTTP. Las rutas son finas: validan entrada, llaman a servicios y traducen errores a mensajes
// para la familia (nunca detalles internos).
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const config = require("./config");
const { store } = require("./catalog/catalogStore");
const { tokenize } = require("./matching/text");
const { createBudget, matchLines, priceLines, BudgetError } = require("./budget/budgetService");
const { renderBudgetPdf } = require("./budget/pdf");
const { FileError } = require("./parsing/fileReader");
const { logger } = require("./observability/logger");

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Render: IP real en X-Forwarded-For (necesario para el rate limit)

  // Logs de acceso sin contenido de las listas.
  app.use((req, res, next) => {
    const started = Date.now();
    req.id = crypto.randomBytes(6).toString("hex");
    res.setHeader("X-Request-Id", req.id);
    res.on("finish", () => {
      if (req.path.startsWith("/assets")) return;
      logger.info("http", { id: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started });
    });
    next();
  });

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  app.use(cors({ origin: (origin, cb) => cb(null, !origin || config.http.allowedOrigins.includes(origin)) }));

  const upload = multer({
    storage: multer.memoryStorage(), // nunca a disco
    limits: { fileSize: config.http.maxUploadBytes, files: config.http.maxFiles, fields: 5, fieldSize: config.http.maxPastedChars * 2 },
  });

  const budgetLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: config.http.rateLimitPer10Min,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Hiciste muchas consultas seguidas. Esperá unos minutos e intentá de nuevo." },
  });
  const lightLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: config.http.matchRateLimitPerMin,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Demasiadas consultas. Esperá un momento." },
  });

  // ── Presupuesto completo (archivo/s o texto pegado) ──────────────
  app.post("/api/presupuestar", budgetLimiter, upload.array("lista", config.http.maxFiles), async (req, res, next) => {
    try {
      const text = typeof req.body.texto === "string" ? req.body.texto : "";
      const files = req.files || [];
      if (!files.length && !text.trim()) throw new BudgetError("empty", "Subí una foto o un archivo con la lista, o pegá el texto.");
      const budget = await createBudget({ files, text });
      res.json(budget);
    } catch (e) {
      next(e);
    }
  });

  // ── Re-matchear líneas editadas (sin IA) ─────────────────────────
  app.post("/api/match", lightLimiter, express.json({ limit: "100kb" }), (req, res) => {
    const lines = Array.isArray(req.body && req.body.lines) ? req.body.lines : null;
    if (!lines || !lines.length) return res.status(400).json({ error: "Faltan los ítems." });
    res.json({ success: true, ...matchLines(lines) });
  });

  // ── Buscar producto para reemplazar o agregar a mano ─────────────
  app.get("/api/productos/buscar", lightLimiter, (req, res) => {
    const q = String(req.query.q || "").slice(0, 100);
    const tokens = tokenize(q);
    if (!tokens.length) return res.json({ results: [] });
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 12));
    const results = store.search(tokens, { limit, filter: (p) => p.sellable }).map(({ product: p }) => ({
      id: p.id, name: p.name, sku: p.sku, price: Math.min(...p.variants.filter((v) => v.sellable).map((v) => v.price)),
      imageUrl: p.imageUrl, url: p.url, concept: p.concept,
      variants: p.variants.filter((v) => v.sellable).map((v) => ({ id: v.id, label: v.options.join(" / ") || null, price: v.price })),
    }));
    res.json({ results });
  });

  // ── Validar precios de una selección (para carrito, WhatsApp, compartir) ──
  app.post("/api/presupuesto/validar", lightLimiter, express.json({ limit: "100kb" }), (req, res) => {
    const lines = Array.isArray(req.body && req.body.lines) ? req.body.lines : null;
    if (!lines || !lines.length) return res.status(400).json({ error: "Faltan los ítems." });
    res.json({ success: true, ...priceLines(lines) });
  });

  // ── PDF (precios recalculados desde catálogo) ─────────────────────
  app.post("/api/presupuesto-pdf", lightLimiter, express.json({ limit: "200kb" }), (req, res) => {
    const body = req.body || {};
    let lines = Array.isArray(body.lines) ? body.lines : null;
    let pending = Array.isArray(body.pending) ? body.pending : [];
    // Formato del widget v1: { items: [{ matched, catalogId, quantity, requestedItem }] }
    if (!lines && Array.isArray(body.items)) {
      lines = body.items.filter((i) => i && i.matched && !i.inStoreOnly && i.catalogId != null)
        .map((i) => ({ productId: i.catalogId, variantId: i.product && i.product.variantId, packs: i.quantity, requestedItem: i.requestedItem }));
      pending = body.items.filter((i) => i && (!i.matched || i.inStoreOnly)).map((i) => ({ requestedItem: i.requestedItem, packs: i.quantity, note: i.inStoreOnly ? "sólo en sucursal" : null }));
    }
    if (!lines || lines.length > 300) return res.status(400).json({ error: "Faltan los datos del presupuesto." });
    const priced = priceLines(lines);
    const unavailable = priced.lines.filter((l) => !l.available).map((l) => ({ requestedItem: l.requestedItem, packs: l.packs, note: "sin stock online" }));
    const cleanPending = pending.slice(0, 200).map((p) => ({
      requestedItem: String((p && p.requestedItem) || "").slice(0, 200), packs: Math.max(1, Math.min(999, parseInt(p && p.packs, 10) || 1)),
      note: p && p.note ? String(p.note).slice(0, 60) : null,
    })).filter((p) => p.requestedItem);
    const budgetId = String(body.budgetId || "").replace(/[^A-Z0-9]/gi, "").slice(0, 12) || crypto.randomBytes(4).toString("hex").toUpperCase();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="presupuesto-lerma-${budgetId}.pdf"`);
    renderBudgetPdf({ budgetId, lines: priced.lines, total: priced.total, pending: [...cleanPending, ...unavailable],
      schoolName: typeof body.schoolName === "string" ? body.schoolName.slice(0, 120) : "" }, res);
  });

  // ── Catálogo público (campos públicos, sin stock exacto) ─────────
  app.get("/api/catalogo", lightLimiter, (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=600");
    res.json(store.products.map((p) => ({ id: p.id, name: p.name, sku: p.sku, slug: p.slug, price: p.price, available: p.sellable, url: p.url })));
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", catalog: { products: store.products.length, syncedAt: store.meta.syncedAt || null, source: store.meta.source }, ai: config.ai.enabled && Boolean(process.env.ANTHROPIC_API_KEY) });
  });

  // ── Widget ────────────────────────────────────────────────────────
  app.use("/assets", express.static(path.join(config.root, "public", "assets"), { maxAge: "7d" }));
  app.get("/widget", (req, res) => {
    // Sólo se puede embeber desde la tienda.
    res.setHeader("Content-Security-Policy", `frame-ancestors 'self' ${config.http.allowedOrigins.join(" ")}`);
    res.sendFile(path.join(config.root, "public", "widget.html"));
  });
  app.get("/", (req, res) => res.json({ status: "🟢 Presupuestador activo" }));

  // ── Errores ───────────────────────────────────────────────────────
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const msg = err.code === "LIMIT_FILE_SIZE" ? "El archivo es muy pesado (máximo " + Math.round(config.http.maxUploadBytes / 1048576) + " MB)."
        : err.code === "LIMIT_FILE_COUNT" ? `Podés subir hasta ${config.http.maxFiles} archivos.` : "No pudimos recibir el archivo.";
      return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: msg, code: err.code });
    }
    if (err instanceof FileError) return res.status(415).json({ error: err.userMessage, code: err.code });
    if (err instanceof BudgetError) return res.status(err.httpStatus).json({ error: err.userMessage, code: err.code });
    if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Datos inválidos." });
    logger.error("unhandled_error", { id: req.id, path: req.path, message: err && err.message, stack: err && err.stack && err.stack.split("\n").slice(0, 4).join(" | ") });
    res.status(500).json({ error: "No pudimos procesar la lista. Intentá de nuevo o escribinos por WhatsApp.", code: "internal" });
  });

  return app;
}

module.exports = { createApp };
