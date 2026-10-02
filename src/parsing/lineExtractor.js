// Extracción determinística de ítems desde texto (sin IA). Se usa cuando la IA falla o no está configurada.
// Cubre los formatos que aparecen en listas reales:
//   "- 2 lápices negros" · "1 VOLIGOMA – 1 SILICONA LÍQUIDA" · "1 fibrón flúo y 1 fibrón pastel"
//   "Cartuchera completa: lápiz negro, borrador, sacapuntas, regla" · "*Carpeta 3 solapas*Block hojas blancas N°5"
//   "Papel glasé (1 flúo, 1 mate, 1 metalizado)" · "… (puede ser el del año anterior)" → opcional
const { normalize } = require("../matching/text");
const { findConcepts } = require("../matching/concepts");
const { splitCompound, leadingQuantity } = require("../matching/requestParser");

const NOISE = /\b(lista|utiles|materiales|grado|ano lectivo|sala de|turno|nivel|seno|maestra|docente|colegio|escuela|instituto|ciclo lectivo|importante|nota|observacion|todo con nombre|forrad|rotulad|traer|entregar|fecha|alumno|apellido|nombre|horario|entrada|salida|firma|tel|cel)\b/;
const OPTIONAL = /opcional|ano (anterior|pasado)|del (ciclo|ano) (pasado|anterior)|reciclar|puede(n)? (ser|usar|utilizar) (el|la|los|las) (del|de)|se (adquiere|compra|entrega|enviara)|adquirir en|traer (el|la) usad/;
// Encabezados de materia o sección: lo que sigue después de ":" son los útiles.
const SECTION = /^(castellano|lengua|ingles|english|matematica|ciencias|cs\.?|sociales|naturales|plastica|artistica|arte|musica|taller|tecnologia|informatica|computacion|educacion|formacion|religion|catequesis|papeles|elementos|utiles|materiales|para la carpeta|higiene|merienda)\b/;

const hasConcept = (t) => findConcepts(normalize(t), "req").length > 0;

function stripBullet(line) {
  return line
    .replace(/^\s*[-–—•·*>✓✔□■▪◦●☐☑⊛]+\s*/, "")
    .replace(/^\s*\d{1,2}[.)]\s+(?=\d)/, "") // "1. 2 cuadernos" → enumeración + cantidad
    .replace(/^\s*[a-z][.)]\s+/i, "") // "a) …"
    .trim();
}

function looksLikeItem(text) {
  const norm = normalize(text);
  if (!norm || norm.length < 3) return false;
  if (hasConcept(text)) return true;
  // Sin concepto conocido: sólo si empieza con cantidad y no parece un encabezado/indicación.
  const { quantity } = leadingQuantity(norm);
  return Boolean(quantity) && !NOISE.test(norm);
}

// Separa una línea en partes, en este orden (los paréntesis con cantidades se resuelven primero).
function splitLine(line) {
  let parts = line.split(/\s*[;*•]\s*/).filter(Boolean);
  parts = parts.flatMap((p) => splitCompound(p));
  // "1 VOLIGOMA – 1 SILICONA" / "… y 1 fibrón pastel" / ", 2 tijeras": separar donde arranca otra cantidad
  parts = parts.flatMap((p) => (/\(/.test(p) ? [p] : p.split(/\s*(?:[–—]|\s-\s|,|\by\b)\s*(?=\d+\s+\S)/)));
  // "Cartuchera completa: lápiz negro, borrador, sacapuntas"
  parts = parts.flatMap((p) => {
    const m = p.match(/^([^:]{2,60}):\s*(.+)$/);
    if (!m) return [p];
    const [, head, rest] = m;
    const pieces = rest.split(/\s*,\s*|\s+y\s+(?=[a-záéíóú])/i).map((s) => s.trim()).filter(Boolean);
    const headIsSection = SECTION.test(normalize(head)) && !hasConcept(head);
    const usefulPieces = pieces.filter((s) => hasConcept(s) || /^\d+\s/.test(s));
    if (usefulPieces.length < 2) return headIsSection ? [rest] : [p];
    return headIsSection ? usefulPieces : [head, ...usefulPieces];
  });
  return parts;
}

// Los PDFs cortan renglones: una línea que empieza en minúscula continúa la anterior.
function joinWrapped(text) {
  const out = [];
  for (const raw of String(text).split(/\n/)) {
    const line = raw.trim();
    if (!line) { out.push(""); continue; }
    const prev = out.length ? out[out.length - 1] : "";
    if (prev && /^[a-záéíóúñ(]/.test(line) && !/[.:;]$/.test(prev)) out[out.length - 1] = prev + " " + line;
    else out.push(line);
  }
  return out;
}

function extractLines(rawText) {
  const out = [];
  let ignored = 0;
  for (const rawLine of joinWrapped(rawText)) {
    const line = stripBullet(rawLine);
    if (!line) continue;
    const optional = OPTIONAL.test(normalize(line));
    for (const part of splitLine(line)) {
      const clean = stripBullet(part).replace(/[.:]+$/, "").trim();
      if (looksLikeItem(clean)) {
        out.push({ text: clean.slice(0, 200), quantity: null, grade: null, optional, note: optional ? "Según la lista, puede ser opcional o reutilizado" : null });
      } else ignored++;
    }
  }
  return { items: out.slice(0, 200), ignored };
}

module.exports = { extractLines, looksLikeItem, splitLine };
