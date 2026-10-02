// Documento (texto, fotos, PDF) → ítems estructurados. La IA sólo LEE la lista: no ve el catálogo, no elige
// productos, no pone precios. Eso lo hace el motor determinístico.
const { z } = require("zod");
const { structured } = require("./client");

const ItemSchema = z.object({
  item: z.string().describe("Producto pedido sin la cantidad, con todos sus detalles (tamaño, color, marca, número, hojas, rayado, etc.)"),
  quantity: z.number().int().describe("Cantidad pedida; 1 si no se indica"),
  grade: z.string().nullable().describe("Grado/curso/sala al que pertenece el ítem si el documento tiene listas de varios cursos; si no, null"),
});

const ExtractionSchema = z.object({
  items: z.array(ItemSchema),
  readable: z.boolean().describe("false si el documento no se puede leer o no es una lista de útiles"),
});

const SYSTEM = `Leés listas de útiles escolares de Argentina (fotos, PDFs o texto) y devolvés los productos pedidos.

Cómo extraer:
- Un ítem por producto. Si una línea pide varios productos ("1 goma y 1 sacapuntas", "papel glasé: 1 flúo, 1 metalizado"), separalos en ítems distintos.
- quantity es la cantidad pedida (el número delante del producto). Si el número describe el contenido ("block de 24 hojas", "lápices x12", "50 hojas A4"), conservá ese número dentro de item tal como está escrito.
- Copiá en item todos los detalles del producto: tamaño (A4, oficio, N°3, N°5), rayado/cuadriculado/liso, cantidad de hojas, color, marca, "o similar", "tapa dura", "punta redonda", "para zurdo".
- Corregí sólo errores de lectura evidentes; no reemplaces palabras por sinónimos ni agregues detalles que no están.
- Si el documento tiene listas de varios cursos o grados, indicá en grade a cuál pertenece cada ítem; si es una sola lista, grade es null.
- No incluyas encabezados, nombres de personas, fechas, firmas ni indicaciones ("todo con nombre", "forrado de azul", "traer el primer día"), salvo que la indicación sea parte del producto.
- Incluí también útiles que una librería quizás no venda (higiene, libros, ropa): otro sistema decide qué hay.
- Si no hay una lista de útiles legible, devolvé readable=false e items vacío.`;

function contentFor(source) {
  if (source.kind === "text") {
    return [{ type: "text", text: `Lista de útiles:\n<<<\n${source.text}\n>>>` }];
  }
  const blocks = [];
  for (const f of source.files) {
    if (f.kind === "pdf") {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.buffer.toString("base64") } });
    } else if (f.kind === "image") {
      blocks.push({ type: "image", source: { type: "base64", media_type: f.mime, data: f.buffer.toString("base64") } });
    } else if (f.kind === "text") {
      blocks.push({ type: "text", text: `Lista de útiles:\n<<<\n${f.text}\n>>>` });
    }
  }
  blocks.push({ type: "text", text: blocks.length > 1 ? "Estas son las páginas o fotos de una misma lista. Extraé los útiles." : "Extraé los útiles de esta lista." });
  return blocks;
}

async function extractItems(source) {
  const { data, usage, model } = await structured({
    task: "extract",
    system: SYSTEM,
    content: contentFor(source),
    schema: ExtractionSchema,
  });
  const items = data.items
    .map((i) => ({ text: i.item.trim().slice(0, 200), quantity: Math.max(1, Math.min(999, i.quantity || 1)), grade: i.grade ? i.grade.slice(0, 60) : null }))
    .filter((i) => i.text);
  return { items: items.slice(0, 200), readable: data.readable, usage, model };
}

module.exports = { extractItems, ExtractionSchema, SYSTEM };
