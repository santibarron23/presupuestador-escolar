// Almacenamiento en memoria: mismo contrato que el de Postgres. Se usa en tests y cuando no hay DATABASE_URL
// (los datos se pierden al reiniciar). Con límites para no crecer sin control.
const MAX_BUDGETS = 5000;
const MAX_DEMAND = 5000;

function createMemoryStorage() {
  const budgets = new Map(); // id → { lines, createdAt, expiresAt, views }
  const metrics = new Map(); // "YYYY-MM-DD|metric" → value
  const demand = new Map(); // key → { key, sample, concept, status, hits, firstSeen, lastSeen }
  const substitutions = new Map(); // "concept|from|to" → { concept, fromId, toId, hits, lastSeen }

  const trim = (map, max) => {
    while (map.size > max) map.delete(map.keys().next().value);
  };

  return {
    kind: "memory",
    persistent: false,
    async init() {},
    async close() {},

    async saveBudget({ id, lines, expiresAt }) {
      budgets.set(id, { lines, createdAt: new Date(), expiresAt, views: 0 });
      trim(budgets, MAX_BUDGETS);
    },
    async getBudget(id) {
      const b = budgets.get(id);
      if (!b || b.expiresAt < new Date()) return null;
      b.views++;
      return { id, lines: b.lines, createdAt: b.createdAt, expiresAt: b.expiresAt, views: b.views };
    },

    async addMetrics(day, increments) {
      for (const [metric, value] of Object.entries(increments)) {
        const k = day + "|" + metric;
        metrics.set(k, (metrics.get(k) || 0) + value);
      }
    },
    async addDemand(entries) {
      const now = new Date();
      for (const e of entries) {
        const d = demand.get(e.key);
        if (d) Object.assign(d, { hits: d.hits + 1, lastSeen: now, status: e.status, concept: e.concept || d.concept });
        else demand.set(e.key, { ...e, hits: 1, firstSeen: now, lastSeen: now });
      }
      trim(demand, MAX_DEMAND);
    },
    async addSubstitution({ concept, fromId, toId }) {
      const k = [concept, fromId, toId].join("|");
      const s = substitutions.get(k) || { concept, fromId, toId, hits: 0 };
      s.hits++;
      s.lastSeen = new Date();
      substitutions.set(k, s);
    },

    async report({ since }) {
      const day = since.toISOString().slice(0, 10);
      const rows = [...metrics].map(([k, value]) => ({ day: k.slice(0, 10), metric: k.slice(11), value })).filter((r) => r.day >= day);
      const recent = (x) => x.lastSeen >= since;
      return {
        metrics: rows,
        demand: [...demand.values()].filter(recent).sort((a, b) => b.hits - a.hits).slice(0, 200),
        substitutions: [...substitutions.values()].filter(recent).sort((a, b) => b.hits - a.hits).slice(0, 100),
        savedBudgets: [...budgets.values()].filter((b) => b.createdAt >= since).length,
      };
    },
  };
}

module.exports = { createMemoryStorage };
