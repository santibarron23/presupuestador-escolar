// Lectura segura de archivos subidos. Todo en memoria (nunca a disco): las listas pueden tener datos de chicos.
// El tipo se decide por el contenido (magic bytes), no por la extensión ni por el mimetype que manda el navegador.
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

class FileError extends Error {
  constructor(code, userMessage) {
    super(userMessage);
    this.code = code;
    this.userMessage = userMessage;
  }
}

// Límite de la API para imágenes en base64 (5 MB). El widget achica las fotos antes de subirlas.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function sniff(buf) {
  if (buf.length < 4) return null;
  const head = buf.subarray(0, 12);
  if (head.subarray(0, 4).toString("latin1") === "%PDF") return { kind: "pdf", mime: "application/pdf" };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: "image", mime: "image/jpeg" };
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", mime: "image/png" };
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return { kind: "image", mime: "image/webp" };
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return { kind: "image", mime: "image/gif" };
  if (head.subarray(4, 12).toString("latin1").match(/ftyp(heic|heix|mif1|msf1|hevc)/)) return { kind: "heic" };
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    return buf.includes(Buffer.from("word/")) ? { kind: "docx" } : { kind: "zip" };
  }
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return { kind: "doc" };
  // Texto: UTF-8 válido y sin bytes nulos
  if (!buf.includes(0) && Buffer.from(buf.toString("utf8"), "utf8").length === buf.length) return { kind: "text", mime: "text/plain" };
  return null;
}

function cleanText(t) {
  return String(t || "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// Un PDF "con texto" se manda como texto (más barato). Si el texto es pobre (escaneado, tabla rota), va como documento.
function pdfTextIsUsable(text) {
  const lines = text.split("\n").filter((l) => l.trim().length > 2);
  const letters = (text.match(/[a-záéíóúñ]/gi) || []).length;
  return lines.length >= 3 && letters >= 30 && letters / Math.max(1, text.length) > 0.4;
}

async function readUpload(file) {
  const buf = file.buffer;
  const type = sniff(buf);
  if (!type) throw new FileError("unsupported", "No reconocemos el formato del archivo. Subí una foto, un PDF, un Word (.docx) o pegá el texto.");
  switch (type.kind) {
    case "image":
      if (buf.length > MAX_IMAGE_BYTES) throw new FileError("too_large", "La foto es muy pesada. Probá sacarla de nuevo o subir una captura de pantalla.");
      return { kind: "image", mime: type.mime, buffer: buf };
    case "pdf": {
      let text = "";
      try {
        text = cleanText((await pdfParse(buf)).text);
      } catch {
        text = "";
      }
      if (text && pdfTextIsUsable(text)) return { kind: "text", text, from: "pdf" };
      return { kind: "pdf", buffer: buf };
    }
    case "docx": {
      const { value } = await mammoth.extractRawText({ buffer: buf });
      const text = cleanText(value);
      if (!text) throw new FileError("empty", "El Word está vacío o no pudimos leerlo.");
      return { kind: "text", text, from: "docx" };
    }
    case "text": {
      const text = cleanText(buf.toString("utf8"));
      if (!text) throw new FileError("empty", "El archivo está vacío.");
      return { kind: "text", text, from: "txt" };
    }
    case "heic":
      throw new FileError("heic", "Las fotos HEIC del iPhone no se pueden leer. Sacá una captura de pantalla de la foto y subila.");
    case "doc":
      throw new FileError("doc", "Los archivos .doc antiguos no se pueden leer. Guardalo como .docx o PDF, o pegá el texto.");
    default:
      throw new FileError("unsupported", "No reconocemos el formato del archivo. Subí una foto, un PDF, un Word (.docx) o pegá el texto.");
  }
}

module.exports = { readUpload, sniff, FileError, pdfTextIsUsable, cleanText, MAX_IMAGE_BYTES };
