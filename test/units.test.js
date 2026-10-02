process.env.NODE_ENV = "test";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalize, singular, tokenize } = require("../src/matching/text");
const { parseRequest, splitCompound } = require("../src/matching/requestParser");
const { extractRequestAttributes } = require("../src/matching/attributes");
const { packsFor } = require("../src/matching/quantity");
const { getConcept } = require("../src/matching/concepts");
const { sniff, pdfTextIsUsable } = require("../src/parsing/fileReader");
const { extractLines } = require("../src/parsing/lineExtractor");
const { unitsPerPackFrom } = require("../src/catalog/catalogStore");

test("normalize", () => {
  assert.equal(normalize("Carpeta N° 3"), "carpeta n3");
  assert.equal(normalize("Block Nº5 x 24 Hojas"), "block n5 x24 hojas");
  assert.equal(normalize("Bolígrafo 0,7"), "boligrafo 0.7");
  assert.equal(normalize("ADH.BARRA 8GRS"), "adh barra 8grs");
  assert.equal(normalize("REPUESTO DE DIBUJO N 5"), "repuesto de dibujo n5");
});

test("singular", () => {
  assert.equal(singular("lapices"), "lapiz");
  assert.equal(singular("fibrones"), "fibron");
  assert.equal(singular("colores"), "color");
  assert.equal(singular("folios"), "folio");
  assert.equal(singular("sobres"), "sobre");
  assert.equal(singular("afiches"), "afiche");
  assert.deepEqual(tokenize("2 Cuadernos de 48 hojas"), ["2", "cuaderno", "48", "hoja"]);
});

test("ejemplo del brief: 2 cuadernos A4 tapa dura rayados de 100 hojas", () => {
  const r = parseRequest("2 cuadernos A4 tapa dura rayados de 100 hojas");
  assert.equal(r.concept, "cuaderno");
  assert.equal(r.quantity, 2);
  assert.equal(r.attrs.formato, "a4");
  assert.equal(r.attrs.tapa, "dura");
  assert.equal(r.attrs.rayado, "rayado");
  assert.equal(r.attrs.hojas, 100);
});

test("cantidad en palabras y al final", () => {
  assert.equal(parseRequest("dos gomas de borrar").quantity, 2);
  assert.equal(parseRequest("cuaderno rayado (3)").quantity, 3);
  assert.equal(parseRequest("hojas A4", { quantityHint: 40 }).quantity, 40);
  assert.equal(parseRequest("50 hojas A4", { quantityHint: 1 }).quantity, 50);
});

test("packs: cantidad pedida vs cantidad comercial", () => {
  const folio = getConcept("folio");
  const req = (t) => parseRequest(t);
  assert.equal(packsFor(req("20 folios"), 10, folio).packs, 2);
  assert.equal(packsFor(req("3 folios"), 10, folio).packs, 1);
  assert.equal(packsFor(req("2 paquetes de folios"), 10, folio).packs, 2);
  const lc = getConcept("lapiz_color");
  assert.equal(packsFor(req("lápices de colores x12"), 12, lc).packs, 1);
  assert.equal(packsFor(req("2 cajas de lápices de colores"), 12, lc).packs, 2);
  assert.equal(packsFor(req("24 lápices de colores"), 12, lc).packs, 2);
  const rep = getConcept("repuesto_hojas");
  assert.equal(packsFor(req("2 repuestos N3"), 96, rep).packs, 2, "2 repuestos son 2 paquetes, no 2 hojas");
  assert.equal(packsFor(req("40 hojas rayadas"), 96, rep).packs, 1);
  assert.equal(packsFor(req("20 hojas rayadas"), null, rep).mode, "unknown-pack-size");
});

test("unidades por paquete desde nombre/variante", () => {
  assert.equal(unitsPerPackFrom("A4 Comun x10"), 10);
  assert.equal(unitsPerPackFrom("Hoja A4 Blanca x50 U."), 50);
  assert.equal(unitsPerPackFrom("REPUESTO A4 96h. TRIUNFANTE"), 96);
  assert.equal(unitsPerPackFrom("Repuesto Rivadavia 480 Hojas Rayadas N3"), 480);
  assert.equal(unitsPerPackFrom("Goma de Borrar 2 BANDERAS Classic"), null);
});

test("atributos: envase y contenido", () => {
  const a = extractRequestAttributes("2 cajas de lapices de colores x12");
  assert.equal(a.container, "caja");
  assert.equal(a.contentCount, 12);
  assert.ok(extractRequestAttributes("cuaderno o similar").brandOptional);
});

test("ítems compuestos", () => {
  assert.deepEqual(splitCompound("Papel glasé (1 fluo, 1 mate, 1 metalizado)"), [
    "1 Papel glasé fluo", "1 Papel glasé mate", "1 Papel glasé metalizado",
  ]);
  assert.deepEqual(splitCompound("Carpeta (con elástico)"), ["Carpeta (con elástico)"]);
});

test("detección de tipo por contenido, no por extensión", () => {
  assert.equal(sniff(Buffer.from("%PDF-1.7 ...")).kind, "pdf");
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])).kind, "image");
  assert.equal(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])).mime, "image/png");
  assert.equal(sniff(Buffer.from("2 lápices\n1 goma")).kind, "text");
  assert.equal(sniff(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4])).kind, "doc");
  assert.equal(sniff(Buffer.from([0, 1, 2, 3, 0, 0, 0, 0, 255, 0])), null);
});

test("PDF con texto útil vs escaneado", () => {
  assert.ok(pdfTextIsUsable("Lista de útiles\n2 lápices negros\n1 goma de borrar\n1 cuaderno rayado"));
  assert.ok(!pdfTextIsUsable("  \n \n12 3\n"));
});

test("extracción determinística de una lista escrita a máquina", () => {
  const { items } = extractLines(`ESCUELA N° 123 - LISTA DE ÚTILES 3er GRADO
Ciclo lectivo 2027
- 2 lápices negros
- 1 goma de borrar; 1 sacapuntas
• Papel glasé (1 fluo, 1 metalizado)
1) 1 carpeta N°3
TODO CON NOMBRE`);
  assert.deepEqual(items.map((i) => i.text), [
    "2 lápices negros", "1 goma de borrar", "1 sacapuntas", "1 Papel glasé fluo", "1 Papel glasé metalizado", "1 carpeta N°3",
  ]);
});
