#!/usr/bin/env node
// Prueba de carga local (sin costo): levanta la app en este proceso con la IA simulada (demora configurable)
// y le tira los escenarios de temporada alta.
//   node scripts/load-test.js                       → escenarios por defecto
//   LOAD_AI_MS=8000 LOAD_FAMILIES=80 node scripts/load-test.js
// Mide tiempos de respuesta (p50/p95/máx), códigos HTTP, fila de IA y aciertos de caché.
// No usar contra producción: el rate limit (correcto) lo frenaría y la IA real cuesta plata.
process.env.NODE_ENV = "test";
process.env.RATE_LIMIT_PER_10MIN = "1000000";
process.env.MATCH_RATE_LIMIT_PER_MIN = "1000000";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "load-test";
process.env.CATALOG_SYNC_HOURS = "0";

const AI_MS = Number(process.env.LOAD_AI_MS || 6000); // lectura de una foto con la IA real: 5–15 s
const FAMILIES = Number(process.env.LOAD_FAMILIES || 60);
const SAME_PDF = Number(process.env.LOAD_SAME_PDF || 40);
const MATCH_REQUESTS = Number(process.env.LOAD_MATCH || 500);

const { store } = require("../src/catalog/catalogStore");
const { createApp } = require("../src/app");
const ai = require("../src/ai/client");
const { aiCapacityStatus } = require("../src/budget/budgetService");
const config = require("../src/config");

const LIST = ["2 lápices negros HB", "1 goma de borrar", "1 sacapuntas con depósito", "20 folios N°3", "1 cuaderno A4 rayado 100 hojas",
  "1 caja de lápices de colores x12", "1 plasticola 250 gr", "1 tijera punta redonda", "1 regla 30 cm", "1 block de hojas canson N°5 blanco",
  "2 papel afiche", "1 cartuchera", "1 birome azul", "1 resaltador amarillo", "1 voligoma"];
let aiCalls = 0;
ai.setClient({
  messages: {
    parse: async (req) => {
      const isRerank = /candidatos/.test(req.system);
      if (!isRerank) aiCalls++;
      await new Promise((r) => setTimeout(r, isRerank ? AI_MS / 4 : AI_MS));
      return { stop_reason: "end_turn", usage: { input_tokens: 1500, output_tokens: 400 },
        parsed_output: isRerank ? { decisions: [] } : { readable: true, items: LIST.map((item) => ({ item, quantity: 1, grade: null, optional: false, note: null })) } };
    },
  },
});

const pct = (arr, q) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(q * arr.length))] : 0);
function summary(name, results) {
  const ms = results.map((r) => r.ms);
  const codes = results.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {});
  console.log(`\n── ${name}`);
  console.log(`   ${results.length} pedidos · códigos ${JSON.stringify(codes)}`);
  console.log(`   p50 ${(pct(ms, 0.5) / 1000).toFixed(1)} s · p95 ${(pct(ms, 0.95) / 1000).toFixed(1)} s · máx ${(Math.max(...ms) / 1000).toFixed(1)} s`);
  return { codes, p50: pct(ms, 0.5), p95: pct(ms, 0.95) };
}

// Imagen JPEG mínima (alcanza para el detector por contenido); `seed` la hace única (sin caché).
const jpeg = (seed) => new Blob([Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("foto-" + seed)])], { type: "image/jpeg" });
const pdf = new Blob([Buffer.from("%PDF-1.4 lista del colegio")], { type: "application/pdf" });

async function upload(base, blob, name) {
  const fd = new FormData();
  fd.append("lista", blob, name);
  const t = Date.now();
  const res = await fetch(base + "/api/presupuestar", { method: "POST", body: fd });
  await res.text();
  return { status: res.status, ms: Date.now() - t };
}

async function main() {
  store.loadFromDisk();
  const server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`IA simulada: ${AI_MS} ms por lectura · ${config.ai.maxConcurrency} lecturas a la vez · fila máx. ${config.ai.maxQueue} · espera máx. ${config.ai.queueTimeoutMs / 1000} s`);

  // 1. Pico: muchas familias suben fotos distintas al mismo tiempo.
  let peakQueue = 0;
  const watch = setInterval(() => (peakQueue = Math.max(peakQueue, aiCapacityStatus().limiter.waiting)), 50);
  const r1 = await Promise.all(Array.from({ length: FAMILIES }, (_, i) => upload(base, jpeg(i), `foto${i}.jpg`)));
  clearInterval(watch);
  summary(`${FAMILIES} familias suben una foto distinta a la vez`, r1);
  console.log(`   fila máxima: ${peakQueue} · lecturas de IA: ${aiCalls}`);

  // 2. El mismo PDF del colegio, subido por muchas familias a la vez y después.
  aiCalls = 0;
  const r2a = await Promise.all(Array.from({ length: SAME_PDF / 2 }, () => upload(base, pdf, "lista.pdf")));
  const r2b = await Promise.all(Array.from({ length: SAME_PDF / 2 }, () => upload(base, pdf, "lista.pdf")));
  summary(`${SAME_PDF} familias suben el mismo PDF del colegio`, [...r2a, ...r2b]);
  console.log(`   lecturas de IA: ${aiCalls} (caché: ${JSON.stringify(aiCapacityStatus().cache)})`);

  // 3. Ediciones: re-match sin IA (cambiar texto, agregar ítems).
  const t = Date.now();
  // 50 usuarios simultáneos editando sin parar (500 conexiones de golpe agotan el backlog de Windows, no el servidor).
  let next = 0;
  const r3 = [];
  await Promise.all(Array.from({ length: 50 }, async () => { while (next < MATCH_REQUESTS) { const i = next++; r3.push(await oneMatch(i)); } }));
  async function oneMatch(i) {
    const s = Date.now();
    const res = await fetch(base + "/api/match", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines: LIST.map((text, j) => ({ lineId: j + 1, text: i % 2 ? text : text + " " + i })) }) });
    await res.text();
    return { status: res.status, ms: Date.now() - s };
  }
  summary(`${MATCH_REQUESTS} re-matcheos de 15 ítems (sin IA)`, r3);
  console.log(`   ${Math.round(MATCH_REQUESTS / ((Date.now() - t) / 1000))} pedidos/s · memoria ${Math.round(process.memoryUsage().rss / 1048576)} MB`);

  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
