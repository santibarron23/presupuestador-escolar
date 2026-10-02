// Normalización de texto compartida por catálogo, pedidos y lexicón.

// Minúsculas, sin tildes, "N°3" → "n3", "x 12" → "x12", sólo [a-z0-9 ].
function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/�/g, "") // encoding roto del catálogo legacy ("N�5")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/ñ/g, "n")
    .replace(/\bn\s*[°ºo]\s*(?=\d)/g, "n") // n°3, nº 3, no3 → n3
    .replace(/\bn\s+(?=\d{1,2}\b)/g, "n") // "N 3" → n3
    .replace(/\bnro\.?\s*(?=\d)/g, "n")
    .replace(/\bnumero\s+(?=\d)/g, "n")
    .replace(/(\d),(\d)/g, "$1.$2") // 0,7 → 0.7
    .replace(/[^a-z0-9.\s]/g, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ") // el punto sólo se conserva entre dígitos (0.5, 1.5)
    .replace(/\bx\s+(?=\d)/g, "x") // x 12 → x12
    .replace(/\s+/g, " ")
    .trim();
}

// Singulares terminados en "re"/"le"/"ne"/"de" que la regla de "-es" cortaría mal (sobres → sobre, no "sobr").
const E_SINGULARS = new Set(["sobre", "cofre", "estuche", "broche", "afiche", "pote", "lote", "tinte", "molde", "borde",
  "aire", "nombre", "parche", "cierre", "pegamento", "liquide", "cable", "doble", "flexible", "lavable", "borrable"]);

// Plural → singular simple para español (suficiente para vocabulario escolar).
function singular(word) {
  if (word.length <= 3 || /\d/.test(word)) return word;
  if (word.endsWith("s") && E_SINGULARS.has(word.slice(0, -1))) return word.slice(0, -1);
  if (/(ces)$/.test(word)) return word.slice(0, -3) + "z"; // lapices → lapiz
  if (/(iones)$/.test(word)) return word.slice(0, -2); // comunicaciones → comunicacion
  if (/[lnrdj]es$/.test(word)) return word.slice(0, -2); // fibrones → fibron, colores → color
  if (/[aeiou]s$/.test(word)) return word.slice(0, -1); // folios → folio, afiches → afiche
  if (/(es)$/.test(word) && !/[aeiou]es$/.test(word)) return word.slice(0, -2); // colores → color
  return word;
}

const STOPWORDS = new Set([
  "de", "del", "la", "el", "los", "las", "un", "una", "unos", "unas", "y", "o", "con", "para", "p",
  "por", "en", "al", "a", "c", "u", "x", "tipo", "marca", "color", "colores", "varios", "vs", "surtido", "surtidos",
]);

function tokenize(str, { keepStopwords = false } = {}) {
  const out = [];
  for (const raw of normalize(str).split(" ")) {
    if (!raw) continue;
    if (!keepStopwords && STOPWORDS.has(raw)) continue;
    out.push(singular(raw));
  }
  return out;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

// Tolerancia a errores de tipeo según largo (corto = exacto).
function typoTolerance(word) {
  if (word.length <= 4) return 0;
  if (word.length <= 7) return 1;
  return 2;
}

module.exports = { normalize, singular, tokenize, levenshtein, typoTolerance, STOPWORDS };
