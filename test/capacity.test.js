// Fase 4: fila de IA, caché por documento y sync automático del catálogo.
process.env.NODE_ENV = "test";
const fs = require("fs");
const os = require("os");
const path = require("path");
// El sync escribe el snapshot: en los tests, sobre una copia temporal (nunca sobre data/catalog.json).
const TMP = path.join(os.tmpdir(), `catalog-test-${process.pid}.json`);
fs.copyFileSync(path.join(__dirname, "..", "data", "catalog.json"), TMP);
process.env.CATALOG_PATH = TMP;

const test = require("node:test");
const assert = require("node:assert/strict");
const { createLimiter, createCache, sourceKey, CapacityError } = require("../src/ai/capacity");
const { store } = require("../src/catalog/catalogStore");
const ai = require("../src/ai/client");
const { createBudget, configureAiCapacity, aiCapacityStatus, BudgetError } = require("../src/budget/budgetService");
const { syncCatalog, validate, syncStatus } = require("../src/catalog/syncService");

store.loadFromDisk();
test.after(() => fs.rmSync(TMP, { force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("limiter: respeta la concurrencia, informa el lugar en la fila y rechaza si está llena", async () => {
  const lim = createLimiter({ max: 2, maxQueue: 2, queueTimeoutMs: 5000 });
  let running = 0;
  let peak = 0;
  const job = () => lim.run(async () => { running++; peak = Math.max(peak, running); await sleep(30); running--; return "ok"; });
  const positions = [];
  const all = [job(), job(), lim.run(async () => { await sleep(10); return "q"; }, { onQueued: (p) => positions.push(p) }), job()];
  await assert.rejects(job(), (e) => e instanceof CapacityError && e.code === "busy");
  const results = await Promise.all(all);
  assert.equal(peak, 2);
  assert.deepEqual(results, ["ok", "ok", "q", "ok"]);
  assert.equal(positions[0], 1, "primero en la fila");
  assert.equal(lim.status().rejected, 1);
});

test("limiter: la espera tiene tope", async () => {
  const lim = createLimiter({ max: 1, maxQueue: 5, queueTimeoutMs: 20 });
  const slow = lim.run(() => sleep(100));
  await assert.rejects(lim.run(async () => 1), (e) => e.code === "queue_timeout");
  await slow;
});

test("limiter: un error no traba la fila", async () => {
  const lim = createLimiter({ max: 1, maxQueue: 5, queueTimeoutMs: 1000 });
  await assert.rejects(lim.run(async () => { throw new Error("x"); }));
  assert.equal(await lim.run(async () => 2), 2);
  assert.equal(lim.status().active, 0);
});

test("caché: hit, pedidos simultáneos comparten una sola lectura, y no guarda resultados inútiles", async () => {
  const cache = createCache({ ttlMs: 1000, maxEntries: 2 });
  let calls = 0;
  const fn = async () => { calls++; await sleep(20); return { readable: true, n: calls }; };
  const [a, b] = await Promise.all([cache.wrap("k", fn), cache.wrap("k", fn)]);
  assert.equal(calls, 1);
  assert.equal(b.cached, "shared");
  assert.equal((await cache.wrap("k", fn)).cached, "hit");
  assert.equal(a.value.n, 1);
  await cache.wrap("bad", async () => ({ readable: false }), (v) => v.readable);
  assert.equal(cache.get("bad"), undefined);
  await cache.wrap("k2", fn); await cache.wrap("k3", fn);
  assert.equal(cache.status().entries, 2, "respeta el máximo");
});

test("sourceKey: mismo texto con otros espacios = misma clave; otro archivo = otra clave", () => {
  assert.equal(sourceKey({ kind: "text", text: "2 lápices\n1 goma" }), sourceKey({ kind: "text", text: "2  lápices 1 goma " }));
  const f = (b) => ({ kind: "files", files: [{ kind: "image", buffer: Buffer.from(b) }] });
  assert.notEqual(sourceKey(f("a")), sourceKey(f("b")));
});

// ── Integración con el armado del presupuesto (IA simulada) ──
const fake = { calls: 0, delay: 0 };
ai.setClient({
  messages: {
    parse: async (req) => {
      if (/candidatos/.test(req.system)) return { stop_reason: "end_turn", parsed_output: { decisions: [] }, usage: { input_tokens: 1, output_tokens: 1 } };
      fake.calls++;
      await sleep(fake.delay);
      return { stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 },
        parsed_output: { readable: true, items: [{ item: "lápices negros", quantity: 2, grade: null, optional: false, note: null }] } };
    },
  },
});
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test";

test("la misma lista subida por varias familias se lee una sola vez", async () => {
  configureAiCapacity();
  fake.calls = 0;
  fake.delay = 30;
  const text = "2 lápices negros de prueba de caché";
  const [a, b] = await Promise.all([createBudget({ text }), createBudget({ text })]);
  const c = await createBudget({ text });
  assert.equal(fake.calls, 1);
  assert.equal(a.items[0].product.id, c.items[0].product.id);
  assert.equal(c.meta.cached, true);
  assert.equal(c.meta.usage, null, "un resultado de caché no cuenta tokens");
  assert.ok(a.meta.usage.input === 100 || b.meta.usage.input === 100);
  assert.ok(aiCapacityStatus().cache.hits >= 1);
});

test("temporada alta: avisa el lugar en la fila; con fotos y la fila llena, mensaje claro (503)", async () => {
  configureAiCapacity({ limiter: { max: 1, maxQueue: 1, queueTimeoutMs: 5000 } });
  fake.delay = 60;
  const stages = [];
  const photo = (b) => ({ buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(b)]), originalname: "lista.jpg", mimetype: "image/jpeg", size: 10 });
  const first = createBudget({ files: [photo("uno")] });
  const second = createBudget({ files: [photo("dos")], onStage: (s, d) => stages.push([s, d && d.position]) });
  await sleep(5);
  await assert.rejects(createBudget({ files: [photo("tres")] }), (e) => e instanceof BudgetError && e.httpStatus === 503 && /muchas familias/.test(e.userMessage));
  await Promise.all([first, second]);
  assert.ok(stages.some(([s, p]) => s === "queued" && p === 1), JSON.stringify(stages));
  // Con texto pegado no se rechaza: se lee sin IA.
  const third = createBudget({ text: "1 goma de borrar para fila llena" });
  const fourth = createBudget({ text: "1 regla 30 cm para fila llena" });
  const fifth = await createBudget({ text: "1 sacapuntas para fila llena" });
  assert.equal(fifth.meta.extraction, "deterministic");
  await Promise.all([third, fourth]);
  configureAiCapacity();
});

// ── Sync del catálogo ──
const fakeProducts = (n) => Array.from({ length: n }, (_, i) => ({ id: "t" + i, productId: String(9000 + i), sku: "T" + i, name: `Lápiz negro prueba ${i}`,
  price: 100 + i, available: true, variants: [], url: null, imageUrl: null }));

test("sync: rechaza catálogos vacíos o que se achican de golpe, y mantiene el actual", async () => {
  assert.throws(() => validate(fakeProducts(50), 0), /Sólo 50/);
  assert.throws(() => validate(fakeProducts(500), 1600), /cayó/);
  validate(fakeProducts(1500), 1600);

  const before = store.products.length;
  await assert.rejects(syncCatalog({ store, fetcher: async () => fakeProducts(200) }));
  assert.equal(store.products.length, before, "el catálogo bueno sigue en uso");
  assert.equal(syncStatus().failuresInARow, 1);
  await assert.rejects(syncCatalog({ store, fetcher: async () => { throw new Error("tienda caída"); } }));
  assert.equal(syncStatus().lastError, "tienda caída");
  assert.equal(store.products.length, before);
});

test("sync: un catálogo válido se carga en memoria y en el snapshot sin reiniciar", async () => {
  const fresh = fakeProducts(Math.ceil(store.products.length * 0.9));
  await syncCatalog({ store, fetcher: async () => fresh });
  assert.equal(store.products.length, fresh.length);
  assert.equal(syncStatus().failuresInARow, 0);
  const snap = JSON.parse(fs.readFileSync(TMP, "utf8"));
  assert.equal(snap.products.length, fresh.length);
  assert.equal(store.reloadIfChanged(), false, "no vuelve a cargar lo que acaba de escribir");
});
