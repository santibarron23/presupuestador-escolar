// Extracción determinística de ítems desde texto (sin IA). Se usa cuando la IA falla o no está configurada,
// y es suficientemente buena para listas escritas a máquina: una línea por producto, cantidad adelante.
const { normalize } = require("../matching/text");
const { findConcepts } = require("../matching/concepts");
const { splitCompound, leadingQuantity } = require("../matching/requestParser");

const NOISE = /\b(lista|utiles|materiales|grado|ano|año|sala|turno|nivel|seno|maestra|docente|colegio|escuela|instituto|ciclo lectivo|importante|nota|observacion|todo con nombre|forrad|traer|entregar|fecha|alumno|apellido|nombre)\b/;

function stripBullet(line) {
  return line
    .replace(/^\s*[-–—•·*>✓✔□■▪◦]+\s*/, "")
    .replace(/^\s*\d{1,2}[.)]\s+(?=\d)/, "") // "1. 2 cuadernos" → enumeración + cantidad
    .replace(/^\s*[a-z][.)]\s+/i, "") // "a) …"
    .trim();
}

function looksLikeItem(text) {
  const norm = normalize(text);
  if (!norm || norm.length < 3) return false;
  const hasConcept = findConcepts(norm, "req").length > 0;
  const { quantity } = leadingQuantity(norm);
  if (hasConcept) return true;
  // Sin concepto conocido: sólo si empieza con cantidad y no parece un encabezado/indicación.
  return Boolean(quantity) && !NOISE.test(norm);
}

function extractLines(rawText) {
  const out = [];
  let ignored = 0;
  for (const rawLine of String(rawText).split(/\n/)) {
    const line = stripBullet(rawLine);
    if (!line) continue;
    // Varios productos en una línea separados por ";" o por "," cuando cada parte tiene cantidad.
    // Primero los compuestos con paréntesis ("glasé (1 flúo, 1 mate)"), después las comas de afuera.
    let parts = line.split(/\s*;\s*/).flatMap((p) => splitCompound(p));
    parts = parts.flatMap((p) => (/\(/.test(p) ? [p] : p.split(/\s*,\s*(?=\d+\s)/)));
    for (const part of parts) {
      const clean = part.replace(/[.:]+$/, "").trim();
      if (looksLikeItem(clean)) out.push({ text: clean.slice(0, 200), quantity: null, grade: null });
      else ignored++;
    }
  }
  return { items: out.slice(0, 200), ignored };
}

module.exports = { extractLines, looksLikeItem };
