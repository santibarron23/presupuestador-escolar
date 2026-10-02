// Tests de la API con la IA simulada (no gastan créditos ni necesitan API key).
process.env.NODE_ENV = "test";
process.env.RATE_LIMIT_PER_10MIN = "1000";
const test = require("node:test");
const assert = require("node:assert/strict");
const { store } = require("../src/catalog/catalogStore");
const { createApp } = require("../src/app");
const ai = require("../src/ai/client");
const Anthropic = require("@anthropic-ai/sdk");

store.loadFromDisk();

// Cliente falso: responde según la tarea, o falla si se lo pedimos.
const fake = { mode: "ok", calls: [] };
ai.setClient({
  messages: {
    parse: async (req) => {
      fake.calls.push(req);
      if (fake.mode === "overloaded") throw new Anthropic.InternalServerError(529, { type: "error", error: { type: "overloaded_error" } }, "Overloaded", new Headers());
      const isRerank = /candidatos/.test(req.system);
      const parsed = isRerank
        ? { decisions: [] }
        : {
            readable: true,
            items: [
              { item: "lápices negros", quantity: 2, grade: null, optional: false, note: null },
              { item: "birome roja", quantity: 1, grade: null, optional: false, note: null },
              { item: "folios A4", quantity: 20, grade: null, optional: false, note: null },
              { item: "papel higiénico", quantity: 1, grade: null, optional: false, note: null },
              { item: "cortante de masa", quantity: 1, grade: null, optional: false, note: null },
              { item: "<img src=x onerror=alert(1)>", quantity: 1, grade: null, optional: false, note: null },
            ],
          };
      return { stop_reason: "end_turn", parsed_output: parsed, usage: { input_tokens: 10, output_tokens: 10 } };
    },
  },
});

let server;
let base;
test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const postList = (fields) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fetch(base + "/api/presupuestar", { method: "POST", body: fd });
};

test("presupuesto desde texto pegado: precios del catálogo y campos del widget v1", async () => {
  fake.mode = "ok";
  const res = await postList({ texto: "2 lápices negros\n1 birome roja\n20 folios A4\n1 papel higiénico" });
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.meta.extraction, "ai");
  const lapiz = b.items.find((i) => i.requestedItem === "lápices negros");
  assert.equal(lapiz.status, "matched");
  assert.equal(lapiz.matched, true);
  assert.equal(lapiz.quantity, 2);
  assert.equal(lapiz.unitPrice, store.get(lapiz.catalogId).variants[0].price);
  const folios = b.items.find((i) => i.requestedItem === "folios A4");
  assert.equal(folios.quantity, 2, "20 folios = 2 paquetes x10");
  assert.equal(b.items.find((i) => i.requestedItem === "papel higiénico").status, "not_sold");
  assert.ok(!["matched", "review"].includes(b.items.find((i) => i.requestedItem === "cortante de masa").status));
  const total = b.items.filter((i) => ["matched", "review"].includes(i.status)).reduce((s, i) => s + i.subtotal, 0);
  assert.equal(b.summary.estimatedTotal, Math.round(total * 100) / 100);
  // La IA no recibe el catálogo: el prompt es chico.
  const extractCall = fake.calls.find((c) => !/candidatos/.test(c.system));
  assert.ok(JSON.stringify(extractCall.messages).length < 2000);
});

test("IA saturada + texto → sigue funcionando sin IA", async () => {
  fake.mode = "overloaded";
  const res = await postList({ texto: "2 lápices negros\n1 goma de borrar\n1 sacapuntas" });
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.meta.extraction, "deterministic");
  assert.equal(b.items.length, 3);
  assert.ok(b.warnings.length > 0);
  fake.mode = "ok";
});

test("IA saturada + foto → mensaje amable, sin detalles internos", async () => {
  fake.mode = "overloaded";
  const jpeg = new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])], { type: "image/jpeg" });
  const fd = new FormData();
  fd.append("lista", jpeg, "lista.jpg");
  const res = await fetch(base + "/api/presupuestar", { method: "POST", body: fd });
  const b = await res.json();
  assert.equal(res.status, 503);
  assert.doesNotMatch(b.error, /529|overload|json|stack/i);
  fake.mode = "ok";
});

test("archivo con extensión engañosa se rechaza por contenido", async () => {
  const fd = new FormData();
  fd.append("lista", new Blob([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4])], { type: "application/pdf" }), "lista.pdf");
  const res = await fetch(base + "/api/presupuestar", { method: "POST", body: fd });
  assert.equal(res.status, 415);
  assert.match((await res.json()).error, /docx|PDF/);
});

test("sin archivo ni texto → 400 amable", async () => {
  const res = await postList({});
  assert.equal(res.status, 400);
});

test("re-match de línea editada sin IA ('Carpeta N5' → 'Carpeta N3')", async () => {
  fake.calls.length = 0;
  const res = await fetch(base + "/api/match", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ lines: [{ lineId: 7, text: "1 carpeta N3", quantity: 1 }] }) });
  const b = await res.json();
  assert.equal(b.items[0].lineId, 7);
  assert.equal(b.items[0].concept, "carpeta");
  assert.equal(fake.calls.length, 0, "no llama a la IA");
});

test("validar: ignora precios del navegador", async () => {
  const p = store.products.find((x) => x.sellable);
  const v = p.variants.find((x) => x.sellable);
  const res = await fetch(base + "/api/presupuesto/validar", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ lines: [{ productId: p.id, variantId: v.id, packs: 3, unitPrice: 1, subtotal: 3 }] }) });
  const b = await res.json();
  assert.equal(b.lines[0].unitPrice, v.price);
  assert.equal(b.total, Math.round(v.price * 3 * 100) / 100);
});

test("PDF con formato v1 y precios recalculados", async () => {
  const p = store.products.find((x) => x.sellable);
  const res = await fetch(base + "/api/presupuesto-pdf", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ matched: true, catalogId: p.id, quantity: 2, requestedItem: "algo", unitPrice: 1 }, { matched: false, requestedItem: "otra cosa", quantity: 1 }] }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");
});

test("buscar productos para reemplazo manual", async () => {
  const res = await fetch(base + "/api/productos/buscar?q=folios");
  const b = await res.json();
  assert.ok(b.results.length > 0);
  assert.ok(b.results.every((r) => r.price > 1));
});

test("CORS sólo para la tienda", async () => {
  const evil = await fetch(base + "/api/presupuestar", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  const ok = await fetch(base + "/api/presupuestar", { method: "OPTIONS", headers: { Origin: "https://www.librerialerma.com.ar", "Access-Control-Request-Method": "POST" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://www.librerialerma.com.ar");
});

test("progreso real: ?stream=1 emite etapas y el resultado final", async () => {
  fake.mode = "ok";
  const fd = new FormData();
  fd.append("texto", "2 lápices negros\n1 goma de borrar");
  const res = await fetch(base + "/api/presupuestar?stream=1", { method: "POST", body: fd });
  assert.match(res.headers.get("content-type"), /text\/event-stream/);
  const body = await res.text();
  const stages = [...body.matchAll(/event: stage\ndata: (.*)/g)].map((m) => JSON.parse(m[1]).stage);
  assert.deepEqual(stages.filter((s) => s !== "checking"), ["reading", "extracting", "matching", "pricing"]);
  const result = JSON.parse(body.match(/event: result\ndata: (.*)/)[1]);
  assert.equal(result.success, true);
});

test("progreso real: los errores llegan como evento, sin detalles internos", async () => {
  fake.mode = "overloaded";
  const fd = new FormData();
  fd.append("lista", new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])], { type: "image/jpeg" }), "f.jpg");
  const body = await (await fetch(base + "/api/presupuestar?stream=1", { method: "POST", body: fd })).text();
  const err = JSON.parse(body.match(/event: error\ndata: (.*)/)[1]);
  assert.equal(err.status, 503);
  assert.doesNotMatch(err.error, /529|overload/i);
  fake.mode = "ok";
});

test("validar devuelve lo necesario para el carrito real", async () => {
  const p = store.products.find((x) => x.sellable && x.productId && x.variants.length > 1);
  const v = p.variants.find((x) => x.sellable);
  const b = await (await fetch(base + "/api/presupuesto/validar", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ lines: [{ productId: p.id, variantId: v.id, packs: 1 }] }) })).json();
  assert.equal(b.lines[0].storeProductId, p.productId);
  assert.deepEqual(b.lines[0].variantOptions, v.options);
});

test("config del widget y versión anterior disponible", async () => {
  const c = await (await fetch(base + "/api/widget-config")).json();
  assert.match(c.whatsapp, /^549/);
  assert.equal((await fetch(base + "/widget/v1")).status, 200);
});

test("widget sólo embebible desde la tienda", async () => {
  const res = await fetch(base + "/widget");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'self' https:\/\/librerialerma\.com\.ar/);
});
