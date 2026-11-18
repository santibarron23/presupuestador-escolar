// Seguridad extra y topes de consumo: PDFs largos o dañados, bombas zip, tope diario de tokens de IA,
// tope global de links, líneas por pedido y encabezados de seguridad.
process.env.NODE_ENV = "test";
process.env.AI_GLOBAL_TOKENS_PER_DAY = "1000";
process.env.SHARES_GLOBAL_PER_DAY = "2";
process.env.MAX_PDF_PAGES = "3";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const PDFDocument = require("pdfkit");
const { store } = require("../src/catalog/catalogStore");
const { createApp } = require("../src/app");
const ai = require("../src/ai/client");
const { setStorage } = require("../src/storage");
const { createMemoryStorage } = require("../src/storage/memory");
const { zipStats } = require("../src/parsing/zipGuard");
const { inspectPdf } = require("../src/parsing/pdfText");

store.loadFromDisk();

const calls = [];
ai.setClient({
  messages: {
    parse: async (req) => {
      if (!/candidatos/.test(req.system)) calls.push(req);
      return { stop_reason: "end_turn", usage: { input_tokens: 600, output_tokens: 100 },
        parsed_output: /candidatos/.test(req.system) ? { decisions: [] } : { readable: true, items: [{ item: "goma de borrar", quantity: 1, grade: null, optional: false, note: null }] } };
    },
  },
});

const makePdf = (pages, line = "2 lápices negros\n1 goma de borrar\n1 cuaderno A4 rayado\n1 regla 30 cm") => new Promise((resolve) => {
  const doc = new PDFDocument();
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  doc.on("end", () => resolve(Buffer.concat(chunks)));
  for (let i = 0; i < pages; i++) { if (i) doc.addPage(); doc.text(line); }
  doc.end();
});

// Zip mínimo con el índice (central directory) declarando los tamaños que se pidan.
function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, size } of entries) {
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt32LE(0, 18); lh.writeUInt32LE(size, 22); lh.writeUInt16LE(n.length, 26);
    local.push(lh, n);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt32LE(0, 20); ch.writeUInt32LE(size, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, n);
    offset += 30 + n.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, eocd]);
}

test("PDF: cuenta páginas y extrae texto con pdf.js endurecido", async () => {
  const info = await inspectPdf(await makePdf(2), { maxPages: 5 });
  assert.equal(info.pages, 2);
  assert.match(info.text, /goma de borrar/);
  const many = await inspectPdf(await makePdf(8), { maxPages: 5 });
  assert.equal(many.pages, 8);
  assert.equal(many.text, null, "si se pasa del tope ni se lee");
  await assert.rejects(inspectPdf(Buffer.from("%PDF-1.4 basura que no es un pdf"), {}));
});

test("bomba zip: el índice del zip delata lo que ocuparía descomprimido", () => {
  assert.deepEqual(zipStats(makeZip([{ name: "word/document.xml", size: 1000 }])), { entries: 1, uncompressed: 1000 });
  assert.equal(zipStats(makeZip([{ name: "a", size: 0xffffffff }])), null, "zip64 / tamaño gigante se rechaza");
  assert.equal(zipStats(Buffer.from("no es un zip")), null);
});

let server;
let base;
test.before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const upload = (blob, name, ip) => {
  const fd = new FormData();
  fd.append("lista", blob, name);
  return fetch(base + "/api/presupuestar", { method: "POST", body: fd, headers: { "CF-Connecting-IP": ip } });
};

test("PDF con demasiadas páginas: se rechaza sin llamar a la IA", async () => {
  setStorage(createMemoryStorage());
  calls.length = 0;
  const res = await upload(new Blob([await makePdf(5, " ")], { type: "application/pdf" }), "lista.pdf", "190.0.0.1");
  assert.equal(res.status, 415);
  assert.match((await res.json()).error, /tiene 5 páginas/);
  assert.equal(calls.length, 0);
});

test("PDF dañado: mensaje claro, sin IA", async () => {
  calls.length = 0;
  const res = await upload(new Blob([Buffer.from("%PDF-1.7\n%%garbage")], { type: "application/pdf" }), "x.pdf", "190.0.0.2");
  assert.equal(res.status, 415);
  assert.match((await res.json()).error, /No pudimos abrir ese PDF/);
  assert.equal(calls.length, 0);
});

test("Word con bomba zip: se rechaza antes de abrirlo", async () => {
  const bomb = makeZip([{ name: "word/document.xml", size: 0x7fffffff }]);
  const res = await upload(new Blob([bomb]), "lista.docx", "190.0.0.3");
  assert.equal(res.status, 415);
  assert.match((await res.json()).error, /No pudimos abrir ese Word/);
});

test("PDF con texto: se lee localmente (va a la IA como texto, no como documento)", async () => {
  calls.length = 0;
  const res = await upload(new Blob([await makePdf(1)], { type: "application/pdf" }), "lista.pdf", "190.0.0.4");
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].messages[0].content.every((b) => b.type === "text"), "no se mandó el PDF como documento");
});

test("tope diario de tokens: superado, las fotos reciben mensaje claro y el texto sigue sin IA", async () => {
  setStorage(createMemoryStorage());
  const photo = (b) => new Blob([Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(b)])], { type: "image/jpeg" });
  assert.equal((await upload(photo("tokens-1"), "a.jpg", "191.0.0.1")).status, 200); // 700 tokens
  assert.equal((await upload(photo("tokens-2"), "b.jpg", "191.0.0.2")).status, 200); // 1400: ya pasó el tope
  await new Promise((r) => setTimeout(r, 20));
  const over = await upload(photo("tokens-3"), "c.jpg", "191.0.0.3");
  assert.equal(over.status, 503);
  const fd = new FormData();
  fd.append("texto", "1 regla 30 cm tokens");
  const text = await (await fetch(base + "/api/presupuestar", { method: "POST", body: fd, headers: { "CF-Connecting-IP": "191.0.0.4" } })).json();
  assert.equal(text.meta.extraction, "deterministic");
});

test("tope global de links por día", async () => {
  setStorage(createMemoryStorage());
  const share = (ip) => fetch(base + "/api/presupuestos", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify({ lines: [{ text: "1 goma" }] }) });
  assert.equal((await share("192.0.0.1")).status, 201);
  assert.equal((await share("192.0.0.2")).status, 201);
  const third = await share("192.0.0.3");
  assert.equal(third.status, 503);
  assert.match((await third.json()).error, /PDF o mandarlo por WhatsApp/);
});

test("re-match: más de 40 líneas por pedido se rechaza", async () => {
  const lines = Array.from({ length: 41 }, (_, i) => ({ text: "1 goma " + i }));
  const res = await fetch(base + "/api/match", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lines }) });
  assert.equal(res.status, 413);
});

test("encabezados de seguridad: CSP estricta en el widget, HSTS y Permissions-Policy", async () => {
  const res = await fetch(base + "/widget");
  const csp = res.headers.get("content-security-policy");
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'self' https:\/\/librerialerma\.com\.ar/);
  assert.match(res.headers.get("strict-transport-security"), /max-age=31536000/);
  assert.match(res.headers.get("permissions-policy"), /geolocation=\(\)/);
});
