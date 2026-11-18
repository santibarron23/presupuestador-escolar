// Límites contra abusos: IP real detrás de Cloudflare/Render, ventanas por 10 min / hora / día, horario nocturno,
// tope global de IA, protección de memoria. Límites bajos para poder probarlos.
process.env.NODE_ENV = "test";
process.env.TRUST_CF_CONNECTING_IP = "1"; // simula un despliegue detrás de Cloudflare
process.env.RATE_LIMIT_PER_10MIN = "3";
process.env.RATE_LIMIT_PER_HOUR = "100";
process.env.RATE_LIMIT_PER_DAY = "100";
process.env.AI_GLOBAL_PER_HOUR = "4";
process.env.MAX_REQUEST_MB = "1";
process.env.EVENTS_PER_MIN = "5";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { newDb } = require("pg-mem");
const { store } = require("../src/catalog/catalogStore");
const { createApp } = require("../src/app");
const ai = require("../src/ai/client");
const { setStorage } = require("../src/storage");
const { createMemoryStorage } = require("../src/storage/memory");
const { createPostgresStorage } = require("../src/storage/postgres");
const { normalizeIp, clientIp } = require("../src/security/clientIp");
const { consume, isNight, windowStart, hashIp } = require("../src/security/quota");

store.loadFromDisk();

ai.setClient({
  messages: {
    parse: async (req) => ({
      stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 },
      parsed_output: /candidatos/.test(req.system) ? { decisions: [] } : { readable: true, items: [{ item: "goma de borrar", quantity: 1, grade: null, optional: false, note: null }] },
    }),
  },
});

test("IP: IPv6 se agrupa por /64, IPv4 mapeada se limpia", () => {
  assert.equal(normalizeIp("2800:810:4a3:1f00:abcd:1:2:3"), "2800:810:4a3:1f00::/64");
  assert.equal(normalizeIp("2800:810:4a3:1f00::99"), "2800:810:4a3:1f00::/64");
  assert.equal(normalizeIp("::ffff:181.1.2.3"), "181.1.2.3");
  assert.equal(normalizeIp("181.1.2.3"), "181.1.2.3");
});

test("IP: CF-Connecting-IP sólo se usa si se configuró (si no, cualquiera lo falsifica)", () => {
  const config = require("../src/config");
  const req = { ip: "10.0.0.1", get: (k) => (k.toLowerCase() === "cf-connecting-ip" ? "181.9.9.9" : undefined) };
  config.abuse.trustCfConnectingIp = false;
  assert.equal(clientIp(req), "10.0.0.1");
  config.abuse.trustCfConnectingIp = true;
  assert.equal(clientIp(req), "181.9.9.9");
});

test("IP: se usa CF-Connecting-IP (Cloudflare) y se ignora si no es una IP", () => {
  const req = (h, ip = "10.0.0.1") => ({ ip, get: (k) => h[k.toLowerCase()] });
  assert.equal(clientIp(req({ "cf-connecting-ip": "181.9.9.9" })), "181.9.9.9");
  assert.equal(clientIp(req({ "cf-connecting-ip": "no-es-ip" })), "10.0.0.1");
  assert.equal(clientIp(req({})), "10.0.0.1");
});

test("ventanas: el día empieza a la medianoche de Argentina; la noche es de 0 a 7 h", () => {
  const t = Date.parse("2026-12-10T02:30:00Z"); // 23:30 del 9/12 en Argentina
  assert.equal(windowStart(86400000, t).toISOString(), "2026-12-09T03:00:00.000Z");
  assert.equal(isNight(Date.parse("2026-12-10T04:00:00Z")), true); // 01:00 AR
  assert.equal(isNight(Date.parse("2026-12-10T10:00:00Z")), false); // 07:00 AR
  assert.equal(isNight(Date.parse("2026-12-10T02:30:00Z")), false); // 23:30 AR
});

for (const [name, make] of [["memoria", createMemoryStorage], ["postgres (pg-mem)", () => {
  const { Pool } = newDb().adapters.createPg();
  return createPostgresStorage({ connectionString: "postgres://test", Pool });
}]]) {
  test(`contadores en ${name}: corta al superar el límite y dice cuánto esperar; la regla nocturna sólo de noche`, async () => {
    const s = make();
    await s.init();
    setStorage(s);
    const rules = [{ id: "t_1h", windowMs: 3600000, limit: 2 }, { id: "t_night", windowMs: 3600000, limit: 1, when: isNight }];
    const day = Date.parse("2026-12-10T15:10:00Z"); // 12:10 AR
    assert.equal(await consume("ipA", rules, day), null);
    assert.equal(await consume("ipA", rules, day), null);
    const over = await consume("ipA", rules, day);
    assert.equal(over.rule.id, "t_1h");
    assert.equal(over.retryAfterSec, 50 * 60);
    assert.equal(await consume("ipB", rules, day), null, "otra IP tiene su propio contador");
    const night = Date.parse("2026-12-10T05:10:00Z"); // 02:10 AR
    assert.equal(await consume("ipC", rules, night), null);
    assert.equal((await consume("ipC", rules, night)).rule.id, "t_night");
    await s.close();
  });
}

test("si la base de contadores falla, se cuenta en memoria (no se abre la puerta)", async () => {
  setStorage({ ...createMemoryStorage(), incrementCounters: async () => { throw new Error("db caída"); } });
  const rules = [{ id: "f_1h", windowMs: 3600000, limit: 1 }];
  assert.equal(await consume("ipF", rules), null);
  assert.equal((await consume("ipF", rules)).rule.id, "f_1h");
});

test("la IP nunca se guarda en claro", () => {
  assert.match(hashIp("181.1.2.3"), /^[0-9a-f]{24}$/);
  assert.notEqual(hashIp("181.1.2.3"), hashIp("181.1.2.4"));
});

// ── API ──
let server;
let base;
test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const budget = (ip, fields, extraHeaders = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fetch(base + "/api/presupuestar", { method: "POST", body: fd, headers: { "CF-Connecting-IP": ip, ...extraHeaders } });
};

test("presupuestos por IP: al superar el límite, 429 con mensaje y Retry-After; otra familia sigue normal", async () => {
  setStorage(createMemoryStorage());
  for (let i = 0; i < 3; i++) assert.equal((await budget("181.0.0.1", { texto: `1 goma de borrar ${i}` })).status, 200);
  const blocked = await budget("181.0.0.1", { texto: "1 goma de borrar 4" });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.match((await blocked.json()).error, /muchas consultas seguidas/);
  assert.equal((await budget("181.0.0.2", { texto: "1 regla" })).status, 200);
});

test("falsificar X-Forwarded-For no saltea el límite (sin Cloudflare se cuentan 2 saltos de proxy)", async () => {
  setStorage(createMemoryStorage());
  const send = (spoof) => {
    const fd = new FormData();
    fd.append("texto", "1 lápiz " + spoof);
    // Cadena que llega en producción sin CF-Connecting-IP: "<lo que manda el cliente>, <IP real>, <nodo de Cloudflare>";
    // quien se conecta a la app es el balanceador de Render (acá, 127.0.0.1). El nodo de Cloudflare cambia en cada pedido.
    return fetch(base + "/api/presupuestar", { method: "POST", body: fd, headers: { "X-Forwarded-For": `${spoof}, 190.5.5.5, 172.70.${codes.length}.1` } });
  };
  const codes = [];
  for (const spoof of ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"]) codes.push((await send(spoof)).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
});

test("tope global de IA: fotos → mensaje claro (503); texto → sigue funcionando sin IA; la caché no cuenta", async () => {
  setStorage(createMemoryStorage());
  const photo = (b) => new Blob([Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(b)])], { type: "image/jpeg" });
  const send = (ip, b) => { const fd = new FormData(); fd.append("lista", photo(b), "lista.jpg"); return fetch(base + "/api/presupuestar", { method: "POST", body: fd, headers: { "CF-Connecting-IP": ip } }); };
  for (let i = 0; i < 4; i++) assert.equal((await send(`186.0.0.${i}`, "foto-global-" + i)).status, 200);
  assert.equal((await send("186.0.0.9", "foto-global-0")).status, 200, "la misma foto sale de la caché: no gasta IA");
  const over = await send("186.0.0.10", "foto-global-nueva");
  assert.equal(over.status, 503);
  assert.match((await over.json()).error, /Pegá el texto/);
  const text = await budget("186.0.0.11", { texto: "1 goma de borrar global" });
  const b = await text.json();
  assert.equal(text.status, 200);
  assert.equal(b.meta.extraction, "deterministic");
});

test("archivos demasiado pesados se rechazan antes de leerlos (413)", async () => {
  const big = new Blob([Buffer.alloc(1.5 * 1024 * 1024, 1)], { type: "application/pdf" });
  const fd = new FormData();
  fd.append("lista", big, "grande.pdf");
  const res = await fetch(base + "/api/presupuestar", { method: "POST", body: fd, headers: { "CF-Connecting-IP": "200.1.1.1" } });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /pesan demasiado/);
});

test("eventos: límite por minuto por IP", async () => {
  const codes = [];
  for (let i = 0; i < 7; i++) {
    codes.push((await fetch(base + "/api/eventos", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "201.1.1.1" }, body: JSON.stringify({ event: "pdf_downloaded" }) })).status);
  }
  assert.deepEqual(codes, [204, 204, 204, 204, 204, 429, 429]);
});

test("los pedidos frenados aparecen en el reporte del panel", async () => {
  const { buildReport } = require("../src/analytics/metrics");
  const s = createMemoryStorage();
  setStorage(s);
  for (let i = 0; i < 4; i++) await budget("181.7.7.7", { texto: `1 cuaderno ${i}` });
  await new Promise((r) => setTimeout(r, 20));
  const rep = await buildReport({ days: 1 });
  assert.equal(rep.blocked.budget_10m, 1);
});

test("CF-Connecting-IP: activo sólo en Render (detrás de Cloudflare) o si se pide explícitamente", () => {
  const { execFileSync } = require("child_process");
  const read = (extra) => {
    const env = { ...process.env, ...extra };
    delete env.TRUST_CF_CONNECTING_IP;
    if (extra.TRUST_CF_CONNECTING_IP) env.TRUST_CF_CONNECTING_IP = extra.TRUST_CF_CONNECTING_IP;
    return execFileSync(process.execPath, ["-e", "process.stdout.write(String(require('./src/config').abuse.trustCfConnectingIp))"], { env, cwd: require("path").join(__dirname, "..") }).toString();
  };
  assert.equal(read({}), "false", "Railway / local: nunca por defecto");
  assert.equal(read({ RENDER: "true" }), "true", "Render");
  assert.equal(read({ RENDER: "true", TRUST_CF_CONNECTING_IP: "0" }), "false", "se puede apagar");
  assert.equal(read({ TRUST_CF_CONNECTING_IP: "1" }), "true");
});
