// Fase 3: presupuestos compartibles, métricas anónimas y panel de administración.
// Postgres se prueba con pg-mem (misma API que pg, en memoria): no hace falta una base real.
process.env.NODE_ENV = "test";
process.env.ADMIN_TOKEN = "token-de-prueba-123";
const test = require("node:test");
const assert = require("node:assert/strict");
const { newDb } = require("pg-mem");
const { store } = require("../src/catalog/catalogStore");
const { createApp } = require("../src/app");
const { setStorage } = require("../src/storage");
const { createMemoryStorage } = require("../src/storage/memory");
const { createPostgresStorage } = require("../src/storage/postgres");
const { encodeToken, decodeToken, sanitizeLines } = require("../src/budget/shares");
const { demandKey, budgetIncrements, demandEntries } = require("../src/analytics/metrics");

store.loadFromDisk();
const sellable = store.products.filter((p) => p.sellable);
const P1 = sellable[0];
const P2 = sellable[1];

function pgStorage() {
  const { Pool } = newDb().adapters.createPg();
  return createPostgresStorage({ connectionString: "postgres://test", Pool });
}

for (const [name, make] of [["memoria", createMemoryStorage], ["postgres (pg-mem)", pgStorage]]) {
  test(`almacenamiento ${name}: presupuestos, métricas, demanda y sustituciones`, async () => {
    const s = make();
    await s.init();
    const future = new Date(Date.now() + 86400000);
    await s.saveBudget({ id: "abcdEFGH", lines: [{ text: "2 lápices", productId: P1.id }], expiresAt: future });
    const got = await s.getBudget("abcdEFGH");
    assert.equal(got.lines[0].text, "2 lápices");
    assert.equal(got.views, 1);
    assert.equal(await s.getBudget("noexiste"), null);
    await s.saveBudget({ id: "vencido1", lines: [{ text: "x" }], expiresAt: new Date(Date.now() - 1000) });
    assert.equal(await s.getBudget("vencido1"), null, "un link vencido no se abre");

    const day = new Date().toISOString().slice(0, 10);
    await s.addMetrics(day, { budgets: 1, "req.lapiz": 3 });
    await s.addMetrics(day, { budgets: 2 });
    await s.addDemand([{ key: "papel satinado", sample: "1 papel satinado", concept: null, status: "not_found" }]);
    await s.addDemand([{ key: "papel satinado", sample: "papel satinado", concept: null, status: "not_found" }]);
    await s.addSubstitution({ concept: "lapiz", fromId: "1", toId: "2" });
    await s.addSubstitution({ concept: "lapiz", fromId: "1", toId: "2" });

    const r = await s.report({ since: new Date(Date.now() - 86400000) });
    const budgets = r.metrics.filter((m) => m.metric === "budgets").reduce((a, m) => a + m.value, 0);
    assert.equal(budgets, 3);
    assert.equal(r.demand[0].hits, 2);
    assert.equal(r.substitutions[0].hits, 2);
    assert.equal(r.savedBudgets, 2);
    await s.close();
  });
}

test("link autocontenido: ida y vuelta, y un link manipulado no rompe nada", () => {
  const lines = sanitizeLines([{ text: "2 lápices negros", quantity: 2, productId: P1.id, packs: 2 }, { text: "papel satinado" }]);
  const token = encodeToken(lines);
  assert.match(token, /^z[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeToken(token), lines);
  assert.equal(decodeToken("zbasura!!"), null);
  assert.equal(decodeToken("z" + Buffer.from("no es deflate").toString("base64url")), null);
});

test("sanitizeLines descarta campos desconocidos, productos inexistentes y acota cantidades", () => {
  const [l] = sanitizeLines([{ text: "x".repeat(500), quantity: 99999, productId: "no-existe", price: 1, __proto__: { evil: 1 } }]);
  assert.equal(l.text.length, 200);
  assert.equal(l.quantity, 999);
  assert.equal(l.productId, undefined);
  assert.equal(l.price, undefined);
  assert.equal(sanitizeLines("nope").length, 0);
});

test("métricas: clave de demanda agrupa variantes del mismo pedido", () => {
  assert.equal(demandKey("2 Hojas Canson N°5"), demandKey("hojas canson n 5"));
  const budget = { meta: { extraction: "ai" }, summary: { estimatedTotal: 1000 }, items: [
    { status: "matched", concept: "lapiz", requestedItem: "lápiz" },
    { status: "not_found", concept: null, requestedItem: "papel satinado" },
    { status: "not_found", concept: null, requestedItem: "Papel satinado" },
  ] };
  const inc = budgetIncrements(budget);
  assert.equal(inc.budgets_ai, 1);
  assert.equal(inc["hit.lapiz"], 1);
  assert.equal(demandEntries(budget).length, 1, "el mismo pedido en una lista cuenta una vez");
});

// ── API ────────────────────────────────────────────────────────────
let server;
let base;
test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const post = (path, body, headers = {}) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

for (const [name, make] of [["sin base (link autocontenido)", createMemoryStorage], ["con Postgres (id corto)", pgStorage]]) {
  test(`compartir y reabrir un presupuesto ${name}`, async () => {
    const s = make();
    await s.init();
    setStorage(s);
    const variant = P1.variants.find((v) => v.sellable);
    const res = await post("/api/presupuestos", { lines: [
      { text: "lo que eligió la familia", quantity: 1, productId: P1.id, variantId: variant.id, packs: 3, price: 1 },
      { text: "papel satinado" },
    ] });
    assert.equal(res.status, 201);
    const share = await res.json();
    if (s.persistent) assert.match(share.id, /^[A-Za-z0-9_-]{8}$/);
    else assert.match(share.id, /^z/);
    assert.ok(share.url.endsWith(share.id));

    const open = await fetch(base + "/api/presupuestos/" + share.id);
    assert.equal(open.status, 200);
    const b = await open.json();
    assert.equal(b.items.length, 2);
    // El producto y la cantidad elegidos se respetan; el precio sale del catálogo, no del cliente.
    assert.equal(b.items[0].product.id, P1.id);
    assert.equal(b.items[0].quantity, 3);
    assert.equal(b.items[0].unitPrice, variant.price);
    assert.equal(b.meta.restored, true);

    const page = await fetch(base + "/presupuesto/" + share.id);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Presupuestá tu lista escolar/);
  });
}

test("link inexistente o inválido: 404 con mensaje para la familia", async () => {
  setStorage(createMemoryStorage());
  const r1 = await fetch(base + "/api/presupuestos/AAAAAAAA");
  assert.equal(r1.status, 404);
  assert.match((await r1.json()).error, /venció/);
  const r2 = await fetch(base + "/api/presupuestos/" + encodeURIComponent("<script>"));
  assert.equal(r2.status, 404);
  assert.equal((await post("/api/presupuestos", { lines: [] })).status, 400);
});

test("eventos: sólo los de la lista, sustituciones con IDs válidos, siempre 204", async () => {
  const s = createMemoryStorage();
  setStorage(s);
  assert.equal((await post("/api/eventos", { event: "add_to_cart_clicked", params: { total: 15000, items: 12 } })).status, 204);
  assert.equal((await post("/api/eventos", { event: "inventado", params: {} })).status, 204);
  assert.equal((await post("/api/eventos", { event: "alternative_selected", params: { concept: "lapiz", fromId: P1.id, toId: P2.id } })).status, 204);
  assert.equal((await post("/api/eventos", { event: "alternative_selected", params: { fromId: "x", toId: "y" } })).status, 204);
  // sendBeacon manda text/plain
  const beacon = await fetch(base + "/api/eventos", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ event: "whatsapp_clicked" }) });
  assert.equal(beacon.status, 204);
  await new Promise((r) => setTimeout(r, 20));
  const r = await s.report({ since: new Date(Date.now() - 86400000) });
  const m = Object.fromEntries(r.metrics.map((x) => [x.metric, x.value]));
  assert.equal(m["ev.add_to_cart_clicked"], 1);
  assert.equal(m.cart_value_ars, 15000);
  assert.equal(m["ev.whatsapp_clicked"], 1);
  assert.equal(m["ev.inventado"], undefined);
  assert.equal(r.substitutions.length, 1);
});

test("panel admin: exige token, y el reporte trae la demanda no satisfecha", async () => {
  const s = createMemoryStorage();
  setStorage(s);
  assert.equal((await fetch(base + "/api/admin/reporte")).status, 401);
  assert.equal((await fetch(base + "/api/admin/reporte", { headers: { Authorization: "Bearer otro" } })).status, 401);
  // Un presupuesto real registra métricas y demanda.
  const fd = new FormData();
  fd.append("texto", "2 lápices negros\n1 papel satinado\n1 estampa de la Santísima Trinidad");
  process.env.AI_DISABLED = "1";
  await fetch(base + "/api/presupuestar", { method: "POST", body: fd });
  await new Promise((r) => setTimeout(r, 20));
  const res = await fetch(base + "/api/admin/reporte?dias=7", { headers: { Authorization: "Bearer token-de-prueba-123" } });
  assert.equal(res.status, 200);
  const rep = await res.json();
  assert.equal(rep.kpis.budgets, 1);
  assert.ok(rep.demand.some((d) => /satinado/.test(d.text)));
  assert.equal(rep.storage.persistent, false);
  const page = await fetch(base + "/admin");
  assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'none'");
});

test("PDF con link: el QR apunta a una URL armada por el servidor", async () => {
  setStorage(createMemoryStorage());
  const res = await post("/api/presupuesto-pdf", { budgetId: "ABC123", shareId: "abcdEFGH", lines: [{ productId: P1.id, packs: 1, requestedItem: "x" }] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  const pdf = Buffer.from(await res.arrayBuffer());
  assert.ok(pdf.subarray(0, 5).toString() === "%PDF-");
  assert.ok(pdf.includes("presupuestador-escolar.onrender.com/presupuesto/abcdEFGH"), "el link va en el PDF");
  // Un shareId con una URL no se acepta.
  const evil = await post("/api/presupuesto-pdf", { shareId: "https://phishing.example", lines: [{ productId: P1.id, packs: 1 }] });
  const evilPdf = Buffer.from(await evil.arrayBuffer());
  assert.ok(!evilPdf.includes("phishing"));
});

test("elección manual de la familia se respeta aunque el motor no haya encontrado nada", () => {
  const { matchLines } = require("../src/budget/budgetService");
  for (const text of ["1 papel satinado", "1 litro de vinagre", "???"]) {
    const { items } = matchLines([{ text, productId: P1.id, packs: 2 }]);
    assert.equal(items[0].product && items[0].product.id, P1.id, text);
    assert.equal(items[0].quantity, 2);
    assert.equal(items[0].status, "matched");
  }
  // Sin elección manual sigue sin inventar nada.
  assert.notEqual(matchLines([{ text: "1 papel satinado" }]).items[0].status, "matched");
});
