// Almacenamiento en Postgres administrado. Sólo guarda:
//   - presupuestos compartidos: líneas (texto del ítem, producto, variante, cantidad). Nunca el archivo original,
//     ni IP, ni datos de la familia. Vencen solos (expires_at).
//   - métricas agregadas por día (contadores), demanda no satisfecha (texto normalizado del ítem) y
//     sustituciones (producto propuesto → producto elegido). Nada de esto se puede asociar a una persona.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS saved_budgets (
     id TEXT PRIMARY KEY,
     lines JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at TIMESTAMPTZ NOT NULL,
     views INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS daily_metrics (
     day DATE NOT NULL,
     metric TEXT NOT NULL,
     value BIGINT NOT NULL DEFAULT 0,
     PRIMARY KEY (day, metric))`,
  `CREATE TABLE IF NOT EXISTS unmet_demand (
     key TEXT PRIMARY KEY,
     sample TEXT NOT NULL,
     concept TEXT,
     status TEXT NOT NULL,
     hits INTEGER NOT NULL DEFAULT 0,
     first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_seen TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS substitutions (
     concept TEXT NOT NULL,
     from_id TEXT NOT NULL,
     to_id TEXT NOT NULL,
     hits INTEGER NOT NULL DEFAULT 0,
     last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (concept, from_id, to_id))`,
];

// Pool: clase compatible con pg.Pool (en tests, la de pg-mem).
function createPostgresStorage({ connectionString, sslNoVerify = false, Pool = require("pg").Pool }) {
  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
    ...(sslNoVerify ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  const q = (text, params) => pool.query(text, params);
  let saves = 0;

  return {
    kind: "postgres",
    persistent: true,
    async init() {
      for (const sql of SCHEMA) await q(sql);
    },
    async close() {
      await pool.end();
    },

    async saveBudget({ id, lines, expiresAt }) {
      await q("INSERT INTO saved_budgets (id, lines, expires_at) VALUES ($1, $2, $3)", [id, JSON.stringify(lines), expiresAt]);
      // Limpieza ocasional de vencidos (no hace falta un cron).
      if (++saves % 50 === 1) await q("DELETE FROM saved_budgets WHERE expires_at < now()");
    },
    async getBudget(id) {
      const { rows } = await q(
        "UPDATE saved_budgets SET views = views + 1 WHERE id = $1 AND expires_at > now() RETURNING id, lines, created_at, expires_at, views",
        [id],
      );
      if (!rows.length) return null;
      const r = rows[0];
      return { id: r.id, lines: typeof r.lines === "string" ? JSON.parse(r.lines) : r.lines, createdAt: r.created_at, expiresAt: r.expires_at, views: r.views };
    },

    async addMetrics(day, increments) {
      const entries = Object.entries(increments).filter(([, v]) => v);
      if (!entries.length) return;
      const params = [day];
      const values = entries.map(([metric, value]) => {
        params.push(metric, Math.round(value));
        return `($1, $${params.length - 1}, $${params.length})`;
      });
      await q(
        `INSERT INTO daily_metrics (day, metric, value) VALUES ${values.join(", ")}
         ON CONFLICT (day, metric) DO UPDATE SET value = daily_metrics.value + EXCLUDED.value`,
        params,
      );
    },
    async addDemand(entries) {
      for (const e of entries) {
        await q(
          `INSERT INTO unmet_demand (key, sample, concept, status, hits) VALUES ($1, $2, $3, $4, 1)
           ON CONFLICT (key) DO UPDATE SET hits = unmet_demand.hits + 1, last_seen = now(), status = EXCLUDED.status,
             concept = COALESCE(EXCLUDED.concept, unmet_demand.concept)`,
          [e.key, e.sample, e.concept || null, e.status],
        );
      }
    },
    async addSubstitution({ concept, fromId, toId }) {
      await q(
        `INSERT INTO substitutions (concept, from_id, to_id, hits) VALUES ($1, $2, $3, 1)
         ON CONFLICT (concept, from_id, to_id) DO UPDATE SET hits = substitutions.hits + 1, last_seen = now()`,
        [concept, fromId, toId],
      );
    },

    async report({ since }) {
      const day = since.toISOString().slice(0, 10);
      const [metrics, demand, subs, saved] = await Promise.all([
        q("SELECT day, metric, value FROM daily_metrics WHERE day >= $1", [day]),
        q("SELECT key, sample, concept, status, hits, first_seen, last_seen FROM unmet_demand WHERE last_seen >= $1 ORDER BY hits DESC LIMIT 200", [since]),
        q("SELECT concept, from_id, to_id, hits, last_seen FROM substitutions WHERE last_seen >= $1 ORDER BY hits DESC LIMIT 100", [since]),
        q("SELECT count(*) AS n FROM saved_budgets WHERE created_at >= $1", [since]),
      ]);
      const isoDay = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
      return {
        metrics: metrics.rows.map((r) => ({ day: isoDay(r.day), metric: r.metric, value: Number(r.value) })),
        demand: demand.rows.map((r) => ({ key: r.key, sample: r.sample, concept: r.concept, status: r.status, hits: r.hits, firstSeen: r.first_seen, lastSeen: r.last_seen })),
        substitutions: subs.rows.map((r) => ({ concept: r.concept, fromId: r.from_id, toId: r.to_id, hits: r.hits, lastSeen: r.last_seen })),
        savedBudgets: Number(saved.rows[0].n),
      };
    },
  };
}

module.exports = { createPostgresStorage, SCHEMA };
