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
const { createBudget, matchLines, priceLines, BudgetError, aiCapacityStatus } = require("./budget/budgetService");
const { syncCatalog, syncStatus } = require("./catalog/syncService");
const { renderBudgetPdf } = require("./budget/pdf");
const { FileError } = require("./parsing/fileReader");
const { logger } = require("./observability/logger");
const { createShare, loadShare, restoreBudget, isShareId, shareUrl } = require("./budget/shares");
const { recordBudget, recordClientEvent, recordSubstitution, recordMetric, buildReport, latency } = require("./analytics/metrics");
const { getStorage } = require("./storage");

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
  // ?stream=1 → Server-Sent Events con las etapas reales y el resultado final (para la barra de progreso).
  app.post("/api/presupuestar", budgetLimiter, upload.array("lista", config.http.maxFiles), async (req, res, next) => {
    const stream = req.query.stream === "1";
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const text = typeof req.body.texto === "string" ? req.body.texto : "";
      const files = req.files || [];
      if (!files.length && !text.trim()) throw new BudgetError("empty", "Subí una foto o un archivo con la lista, o pegá el texto.");
      if (stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
        res.flushHeaders();
      }
      const budget = await createBudget({ files, text, onStage: stream ? (stage, data) => send("stage", { stage, ...data }) : undefined });
      recordBudget(budget);
      if (stream) {
        send("result", budget);
        res.end();
      } else res.json(budget);
    } catch (e) {
      if (!stream || !res.headersSent) return next(e);
      const { status, body } = errorResponse(e, req);
      send("error", { ...body, status });
      res.end();
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

  // ── Presupuestos compartibles ──────────────────────────────────────
  const shareLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false,
    message: { error: "Demasiados links seguidos. Esperá unos minutos." } });
  app.post("/api/presupuestos", shareLimiter, express.json({ limit: "100kb" }), async (req, res, next) => {
    try {
      const share = await createShare(req.body && req.body.lines);
      if (!share) return res.status(400).json({ error: "Faltan los ítems." });
      recordMetric("share_created");
      res.status(201).json({ success: true, ...share });
    } catch (e) { next(e); }
  });
  app.get("/api/presupuestos/:id", lightLimiter, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const lines = isShareId(id) ? await loadShare(id) : null;
      if (!lines || !lines.length) return res.status(404).json({ error: "Este presupuesto venció o el link está incompleto. Podés armarlo de nuevo en un minuto." });
      recordMetric("share_opened");
      res.setHeader("Cache-Control", "no-store");
      res.json(restoreBudget(id, lines));
    } catch (e) { next(e); }
  });

  // ── Métricas anónimas del widget (sin cookies ni identificadores) ─────
  app.post("/api/eventos", lightLimiter, express.json({ limit: "4kb", type: ["application/json", "text/plain"] }), (req, res) => {
    const body = typeof req.body === "string" ? safeJson(req.body) : req.body;
    if (body && typeof body.event === "string") {
      if (body.event === "alternative_selected" && body.params) recordSubstitution(body.params);
      recordClientEvent(body.event, body.params);
    }
    res.status(204).end();
  });

  // ── PDF (precios recalculados desde catálogo) ─────────────────────
  app.post("/api/presupuesto-pdf", lightLimiter, express.json({ limit: "200kb" }), async (req, res) => {
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
    // Link/QR al presupuesto: sólo si el id es válido; la URL la arma el servidor (nunca una URL del cliente).
    const shareId = typeof body.shareId === "string" && isShareId(body.shareId) ? body.shareId : null;
    const link = shareId ? shareUrl(shareId) : null;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="presupuesto-lerma-${budgetId}.pdf"`);
    await renderBudgetPdf({ budgetId, lines: priced.lines, total: priced.total, pending: [...cleanPending, ...unavailable], link,
      schoolName: typeof body.schoolName === "string" ? body.schoolName.slice(0, 120) : "" }, res);
  });

  // ── Catálogo público (campos públicos, sin stock exacto) ─────────
  app.get("/api/catalogo", lightLimiter, (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=600");
    res.json(store.products.map((p) => ({ id: p.id, name: p.name, sku: p.sku, slug: p.slug, price: p.price, available: p.sellable, url: p.url })));
  });

  // Estado para monitoreo (Render health check, UptimeRobot). Sin datos de familias.
  const opsStatus = () => {
    const ageHours = store.meta.syncedAt ? Math.round((Date.now() - Date.parse(store.meta.syncedAt)) / 360000) / 10 : null;
    const sync = syncStatus();
    return {
      catalog: { products: store.products.length, syncedAt: store.meta.syncedAt || null, source: store.meta.source, ageHours,
        // Viejo = más de dos ciclos de sync sin actualizarse.
        stale: ageHours == null || (config.catalog.syncHours > 0 && ageHours > config.catalog.syncHours * 2 + 1),
        sync: { running: sync.running, lastSuccessAt: sync.lastSuccessAt, lastError: sync.lastError, failuresInARow: sync.failuresInARow } },
      ai: { enabled: config.ai.enabled && Boolean(process.env.ANTHROPIC_API_KEY), ...aiCapacityStatus() },
      latency: latency(),
      storage: getStorage().kind,
    };
  };
  app.get("/api/health", (req, res) => {
    const ops = opsStatus();
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: ops.catalog.stale ? "degraded" : "ok", ...ops,
      // compatibilidad: antes `ai` era un booleano
      aiEnabled: ops.ai.enabled });
  });

  // ── Widget ────────────────────────────────────────────────────────
  app.use("/assets", express.static(path.join(config.root, "public", "assets"), { maxAge: "7d" }));
  const sendWidget = (file) => (req, res) => {
    // Sólo se puede embeber desde la tienda.
    res.setHeader("Content-Security-Policy", `frame-ancestors 'self' ${config.http.allowedOrigins.join(" ")}`);
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(config.root, "public", file));
  };
  app.get("/widget", sendWidget("widget.html"));
  app.get("/widget/v1", sendWidget("widget-v1.html")); // versión anterior, por si hay que volver atrás
  // Presupuesto compartido abierto directamente (el widget lee el id de la URL).
  app.get("/presupuesto/:id", (req, res, next) => (isShareId(String(req.params.id)) ? sendWidget("widget.html")(req, res) : next()));

  // ── Panel de administración ───────────────────────────────────────
  // Desactivado si no hay ADMIN_TOKEN. Token por header (nunca en la URL), comparación en tiempo constante.
  const adminLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Demasiados intentos." } });
  const requireAdmin = (req, res, next) => {
    if (!config.data.adminToken) return res.status(404).json({ error: "Panel desactivado (falta ADMIN_TOKEN)." });
    const given = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const hash = (s) => crypto.createHash("sha256").update(s).digest();
    if (!given || !crypto.timingSafeEqual(hash(given), hash(config.data.adminToken))) return res.status(401).json({ error: "Token inválido." });
    next();
  };
  app.get("/admin", (req, res) => {
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("X-Robots-Tag", "noindex");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(config.root, "public", "admin.html"));
  });
  app.get("/api/admin/reporte", adminLimiter, requireAdmin, async (req, res, next) => {
    try {
      const days = Math.max(1, Math.min(365, parseInt(req.query.dias, 10) || 30));
      res.setHeader("Cache-Control", "no-store");
      res.json(await buildReport({ days, ops: opsStatus() }));
    } catch (e) { next(e); }
  });
  // Sincronizar el catálogo ahora (p. ej. después de cargar productos nuevos en la tienda). Corre en segundo plano.
  app.post("/api/admin/sincronizar", adminLimiter, requireAdmin, (req, res) => {
    if (syncStatus().running) return res.status(409).json({ error: "Ya hay una sincronización en curso." });
    syncCatalog({ store }).catch(() => {});
    res.status(202).json({ success: true, message: "Sincronizando. Tarda unos minutos." });
  });
  app.get("/api/widget-config", (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ whatsapp: config.store.whatsapp, storeUrl: config.catalog.storeBaseUrl, validityDays: config.store.budgetValidityDays,
      maxFiles: config.http.maxFiles, catalogSyncedAt: store.meta.syncedAt || null });
  });
  app.get("/", (req, res) => res.json({ status: "🟢 Presupuestador activo" }));

  // ── Errores ───────────────────────────────────────────────────────
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const { status, body } = errorResponse(err, req);
    res.status(status).json(body);
  });

  return app;
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Error → respuesta para la familia (nunca detalles internos).
function errorResponse(err, req) {
  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "El archivo es muy pesado (máximo " + Math.round(config.http.maxUploadBytes / 1048576) + " MB)."
      : err.code === "LIMIT_FILE_COUNT" ? `Podés subir hasta ${config.http.maxFiles} archivos.` : "No pudimos recibir el archivo.";
    return { status: err.code === "LIMIT_FILE_SIZE" ? 413 : 400, body: { error: msg, code: err.code } };
  }
  if (err instanceof FileError) return { status: 415, body: { error: err.userMessage, code: err.code } };
  if (err instanceof BudgetError) return { status: err.httpStatus, body: { error: err.userMessage, code: err.code } };
  if (err && err.type === "entity.parse.failed") return { status: 400, body: { error: "Datos inválidos." } };
  logger.error("unhandled_error", { id: req.id, path: req.path, message: err && err.message, stack: err && err.stack && err.stack.split("\n").slice(0, 4).join(" | ") });
  return { status: 500, body: { error: "No pudimos procesar la lista. Intentá de nuevo o escribinos por WhatsApp.", code: "internal" } };
}

module.exports = { createApp };
