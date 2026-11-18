// Lectura de PDFs subidos por cualquiera: cuenta páginas y extrae texto con pdf.js (Mozilla), endurecido.
//   - isEvalSupported: false → pdf.js nunca compila código del PDF (la clase de fallas de CVE-2024-4367).
//   - Sin fuentes del sistema ni FontFace: sólo se lee texto, no se dibuja nada.
//   - Tope de páginas y de tiempo: un PDF enorme o armado para colgar el parser no consume el servidor.
// Antes se usaba pdf-parse 1.x, que trae una copia de pdf.js de 2017.
let pdfjs = null;
const loadPdfjs = async () => (pdfjs = pdfjs || (await import("pdfjs-dist/legacy/build/pdf.mjs")));

class PdfError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => { onTimeout(); reject(new PdfError("timeout", "El PDF tardó demasiado en abrirse")); }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// → { pages, text }. Si el PDF tiene más de `maxPages` páginas no se lee el texto (text = null).
async function inspectPdf(buffer, { maxPages = 10, timeoutMs = 10000, maxChars = 60000 } = {}) {
  const lib = await loadPdfjs();
  // Copia: pdf.js puede quedarse con el buffer, y el original quizás se manda después a la IA.
  const task = lib.getDocument({
    data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
    enableXfa: false, verbosity: 0,
  });
  const work = (async () => {
    const doc = await task.promise;
    const pages = doc.numPages;
    if (pages > maxPages) return { pages, text: null };
    let text = "";
    for (let n = 1; n <= pages && text.length < maxChars; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      for (const item of content.items) text += (item.str || "") + (item.hasEOL ? "\n" : "");
      text += "\n\n";
      page.cleanup();
    }
    return { pages, text: text.slice(0, maxChars) };
  })();
  try {
    return await withTimeout(work, timeoutMs, () => task.destroy().catch(() => {}));
  } catch (e) {
    if (e instanceof PdfError) throw e;
    throw new PdfError("unreadable", e && e.message);
  } finally {
    task.destroy().catch(() => {});
  }
}

module.exports = { inspectPdf, PdfError };
