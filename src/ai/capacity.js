// Capacidad de la IA en temporada alta:
//   - Limiter: como mucho N lecturas a la vez; el resto espera en una fila acotada (se le informa el lugar).
//     Si la fila está llena o la espera es demasiado larga, se avisa en vez de colgar la conexión.
//   - Caché: la misma lista (mismo archivo o mismo texto) se lee una sola vez. Si dos familias suben el mismo
//     PDF al mismo tiempo, la segunda espera el resultado de la primera en vez de pagar otra lectura.
//     Sólo en memoria, con vencimiento; la clave es un hash del contenido (no se guarda el documento).
const crypto = require("crypto");

class CapacityError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function createLimiter({ max, maxQueue, queueTimeoutMs }) {
  let active = 0;
  const queue = []; // { start, reject, onPosition, timer }
  const stats = { started: 0, queued: 0, rejected: 0, timedOut: 0, maxQueueSeen: 0 };

  const notify = () => queue.forEach((q, i) => q.onPosition && q.onPosition(i + 1));

  function next() {
    while (active < max && queue.length) {
      const q = queue.shift();
      clearTimeout(q.timer);
      q.start();
    }
    notify();
  }

  // run(fn, { onQueued(position) }) → resultado de fn
  function run(fn, { onQueued } = {}) {
    return new Promise((resolve, reject) => {
      const start = () => {
        active++;
        stats.started++;
        // El lugar se libera antes de responder: quien espera el resultado ya ve la fila actualizada.
        const done = () => { active--; next(); };
        Promise.resolve().then(fn).then((v) => { done(); resolve(v); }, (e) => { done(); reject(e); });
      };
      if (active < max) return start();
      if (queue.length >= maxQueue) {
        stats.rejected++;
        return reject(new CapacityError("busy", "Hay muchas listas procesándose"));
      }
      const entry = { start, onPosition: onQueued };
      entry.timer = setTimeout(() => {
        const i = queue.indexOf(entry);
        if (i >= 0) queue.splice(i, 1);
        stats.timedOut++;
        notify();
        reject(new CapacityError("queue_timeout", "La espera fue demasiado larga"));
      }, queueTimeoutMs);
      entry.timer.unref && entry.timer.unref();
      queue.push(entry);
      stats.queued++;
      stats.maxQueueSeen = Math.max(stats.maxQueueSeen, queue.length);
      if (onQueued) onQueued(queue.length);
    });
  }

  return { run, status: () => ({ active, waiting: queue.length, max, maxQueue, ...stats }) };
}

function createCache({ ttlMs, maxEntries }) {
  const entries = new Map(); // key → { value, expires }
  const inflight = new Map(); // key → Promise
  const stats = { hits: 0, misses: 0, shared: 0 };

  function get(key) {
    const e = entries.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      entries.delete(key);
      return undefined;
    }
    // LRU: se vuelve a poner al final
    entries.delete(key);
    entries.set(key, e);
    return e.value;
  }

  function set(key, value) {
    entries.set(key, { value, expires: Date.now() + ttlMs });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  // Devuelve { value, cached: "hit" | "shared" | false }. Sólo se cachean resultados que `shouldCache` acepte.
  async function wrap(key, fn, shouldCache = () => true) {
    const hit = get(key);
    if (hit !== undefined) {
      stats.hits++;
      return { value: hit, cached: "hit" };
    }
    if (inflight.has(key)) {
      stats.shared++;
      return { value: await inflight.get(key), cached: "shared" };
    }
    stats.misses++;
    const p = Promise.resolve().then(fn);
    inflight.set(key, p);
    try {
      const value = await p;
      if (shouldCache(value)) set(key, value);
      return { value, cached: false };
    } finally {
      inflight.delete(key);
    }
  }

  return { wrap, get, set, clear: () => entries.clear(), status: () => ({ entries: entries.size, ...stats }) };
}

// Hash del contenido del documento: texto normalizado (espacios) o bytes de cada archivo, en orden.
function sourceKey(source) {
  const h = crypto.createHash("sha256");
  if (source.kind === "text") h.update("t\0" + source.text.replace(/\s+/g, " ").trim().toLowerCase());
  else for (const f of source.files) {
    h.update("f\0" + f.kind + "\0");
    h.update(f.buffer || Buffer.from(f.text || ""));
  }
  return h.digest("hex");
}

module.exports = { createLimiter, createCache, sourceKey, CapacityError };
