// Desempate por IA, sólo para ítems con confianza media y sólo entre candidatos YA compatibles.
// La IA no puede proponer productos nuevos: elige un id de la lista o "ninguno".
const { z } = require("zod");
const { structured } = require("./client");

const RerankSchema = z.object({
  decisions: z.array(z.object({
    line: z.number().int(),
    choice: z.string().nullable().describe("id del candidato que corresponde a lo pedido, o null si ninguno corresponde"),
  })),
});

const SYSTEM = `Sos vendedor de una librería escolar argentina. Para cada pedido de una lista de útiles te doy candidatos del catálogo.
Elegí el candidato que mejor corresponde a lo que pidió la familia (tipo de producto, tamaño, formato, rayado, color, marca si la pidieron).
Si ninguno corresponde claramente, devolvé choice=null: es mejor no elegir que elegir mal.
No prefieras el más caro. Ante dos opciones equivalentes, elegí la más común para uso escolar.`;

async function rerank(entries) {
  if (!entries.length) return { decisions: new Map() };
  const lines = entries.map((e, i) => {
    const cands = e.candidates.map((c) => `   - id=${c.ref} | ${c.name} | $${Math.round(c.price)}`).join("\n");
    return `${i + 1}. Pedido: "${e.request}"\n${cands}`;
  });
  const { data } = await structured({
    task: "rerank",
    system: SYSTEM,
    content: [{ type: "text", text: lines.join("\n\n") }],
    schema: RerankSchema,
    maxTokens: 4000,
  });
  const decisions = new Map();
  for (const d of data.decisions) {
    const entry = entries[d.line - 1];
    if (!entry) continue;
    // Validación: sólo ids que estaban en la lista.
    if (d.choice !== null && !entry.candidates.some((c) => c.ref === d.choice)) continue;
    decisions.set(entry.key, d.choice);
  }
  return { decisions };
}

module.exports = { rerank, RerankSchema };
