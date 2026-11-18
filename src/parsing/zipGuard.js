// Un .docx es un zip. Antes de abrirlo se lee el índice del zip (sin descomprimir nada) para rechazar
// "bombas zip": pocos MB que al descomprimir ocupan GB y tiran el servidor.
// Formato: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT (End of Central Directory + Central Directory).
const EOCD = 0x06054b50;
const CDH = 0x02014b50;

// → { entries, uncompressed } o null si el zip no se puede leer (índice roto o zip64).
function zipStats(buf) {
  if (buf.length < 22) return null;
  let eocd = -1;
  for (let i = buf.length - 22, min = Math.max(0, buf.length - 22 - 65535); i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || p === 0xffffffff) return null; // zip64: un .docx de una lista nunca lo necesita
  let uncompressed = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH) return null;
    const size = buf.readUInt32LE(p + 24);
    if (size === 0xffffffff) return null;
    uncompressed += size;
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return { entries, uncompressed };
}

module.exports = { zipStats };
