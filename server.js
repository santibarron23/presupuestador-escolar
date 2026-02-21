const express = require("express");
const multer = require("multer");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/", limits: { fileSize: 10 * 1024 * 1024 } });

// ─── CONFIGURACIÓN ────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ─── CATÁLOGO DESDE ARCHIVO ───────────────────────────────────────
// Generado automáticamente desde el CSV de Tienda Nube (1877 productos)
// Para actualizar: exportá de nuevo desde Tienda Nube y reemplazá catalog.json
const CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, "catalog.json"), "utf8"));

// ─── TIPOS DE IMAGEN ──────────────────────────────────────────────
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

// ─── EXTRAER TEXTO DEL ARCHIVO ────────────────────────────────────
async function extractText(filePath, mimeType) {
  if (mimeType === "application/pdf") {
    const buffer = fs.readFileSync(filePath);
    const data = await pdfParse(buffer);
    return data.text;
  } else if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/msword"
  ) {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  } else if (mimeType === "text/plain") {
    return fs.readFileSync(filePath, "utf8");
  } else if (IMAGE_TYPES.includes(mimeType)) {
    return null; // Las imágenes se procesan directo con visión
  }
  throw new Error("Formato no soportado");
}

// ─── PARSEAR LISTA DESDE IMAGEN (visión de Claude) ────────────────
async function parseListFromImage(filePath, mimeType) {
  const imageBuffer = fs.readFileSync(filePath);
  const base64 = imageBuffer.toString("base64");

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mimeType, data: base64 },
            },
            {
              type: "text",
              text: `Esta es una foto de una lista de útiles escolares.
Leé todos los productos que aparecen, incluyendo texto manuscrito o impreso.
Extraé cada ítem con su cantidad. Devolvé SOLO un JSON válido con este formato:
[{"item": "nombre del producto", "quantity": número, "notes": "detalles extra si hay"}]

Si no hay cantidad especificada, usá 1.
Ignorá encabezados, nombres de colegios, grados, fechas y texto irrelevante.
Respondé SOLO con el JSON, sin texto adicional.`,
            },
          ],
        },
      ],
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    }
  );

  const content = response.data.content[0].text.trim();
  const jsonStr = content.replace(/```json|```/g, "").trim();
  return JSON.parse(jsonStr);
}

// ─── PARSEAR LISTA CON CLAUDE (texto) ────────────────────────────
async function parseListWithAI(rawText) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: `Analizá el siguiente texto que es una lista de útiles escolares.
Extraé cada ítem con su cantidad. Devolvé SOLO un JSON válido con este formato:
[{"item": "nombre del producto", "quantity": número, "notes": "detalles extra si hay"}]

Si no hay cantidad especificada, usá 1.
Ignorá encabezados, nombres de colegios, grados, fechas y texto irrelevante.

TEXTO DE LA LISTA:
${rawText}

Respondé SOLO con el JSON, sin texto adicional.`,
        },
      ],
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    }
  );

  const content = response.data.content[0].text.trim();
  return safeJsonParse(content);
}

// ─── MATCHEAR CON CATÁLOGO ────────────────────────────────────────
function safeJsonParse(text) {
  try {
    // Intentar extraer JSON aunque haya texto extra alrededor
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    return JSON.parse(text);
  } catch (e) {
    throw new Error("No se pudo parsear la respuesta de la IA");
  }
}

function preFilterCatalog(items) {
  // Extraer palabras clave de los ítems solicitados
  const keywords = items.flatMap(i =>
    i.item.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  );

  // Filtrar catálogo a productos relevantes (máx 300)
  const scored = CATALOG.map(p => {
    const nameWords = p.name.toLowerCase().split(/\s+/);
    const score = keywords.filter(k => 
      nameWords.some(w => w.includes(k) || k.includes(w))
    ).length;
    return { ...p, score };
  });

  return scored
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 300);
}

async function matchWithCatalog(parsedItems) {
  const relevantCatalog = preFilterCatalog(parsedItems);
  const catalogText = relevantCatalog.map(
    (p) => `ID:${p.id} | "${p.name}" | $${p.price}`
  ).join("\n");

  const itemsText = parsedItems
    .map((i, idx) => `${idx}. "${i.item}" x${i.quantity}`)
    .join("\n");

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: `Tenés este catálogo de productos de una librería:
${catalogText}

Y esta lista de útiles escolares solicitados:
${itemsText}

Para cada ítem de la lista, encontrá el producto más parecido del catálogo.
Devolvé SOLO un array JSON válido con este formato exacto, sin texto adicional:
[{"requestedItem":"nombre solicitado","quantity":1,"matched":true,"catalogId":1,"catalogName":"nombre producto","unitPrice":1000,"subtotal":1000,"confidence":"high"}]

Si no encontrás un producto similar, usá matched:false, catalogId:null, catalogName:null, unitPrice:0, subtotal:0.
Respondé ÚNICAMENTE con el JSON, empezando con [ y terminando con ].`,
        },
      ],
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    }
  );

  const content = response.data.content[0].text.trim();
  return safeJsonParse(content);
}

// ─── ENDPOINT PRINCIPAL ────────────────────────────────────────────
app.post("/api/presupuestar", upload.single("lista"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No se recibió ningún archivo" });

  try {
    // 1. Extraer items según tipo de archivo
    let parsedItems;
    if (IMAGE_TYPES.includes(file.mimetype)) {
      // Imagen → visión directa de Claude
      parsedItems = await parseListFromImage(file.path, file.mimetype);
    } else {
      // PDF / Word / TXT → extraer texto primero
      const rawText = await extractText(file.path, file.mimetype);
      if (!rawText || rawText.trim().length < 10) {
        return res.status(400).json({ error: "No se pudo leer texto del archivo." });
      }
      parsedItems = await parseListWithAI(rawText);
    }

    // 3. Matchear con catálogo
    const matchedItems = await matchWithCatalog(parsedItems);

    // 4. Calcular totales
    const found = matchedItems.filter((i) => i.matched);
    const notFound = matchedItems.filter((i) => !i.matched);
    const total = found.reduce((sum, i) => sum + i.subtotal, 0);
    const coverage = Math.round((found.length / matchedItems.length) * 100);

    res.json({
      success: true,
      summary: {
        totalItems: matchedItems.length,
        foundItems: found.length,
        notFoundItems: notFound.length,
        coveragePercent: coverage,
        estimatedTotal: total,
      },
      items: matchedItems,
      rawText: "", // debug desactivado
    });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: "Error procesando la lista: " + err.message });
  } finally {
    // Limpiar archivo temporal
    if (file) fs.unlink(file.path, () => {});
  }
});

// ─── CATÁLOGO PÚBLICO ──────────────────────────────────────────────
app.get("/api/catalogo", (req, res) => res.json(CATALOG));

// ─── SERVIR WIDGET COMO PÁGINA ────────────────────────────────────
app.get("/widget", (req, res) => {
  const widgetPath = path.resolve(__dirname, "widget.html");
  console.log("Buscando widget en:", widgetPath);
  res.sendFile(widgetPath);
});

app.get("/", (req, res) => res.json({ status: "🟢 Presupuestador activo" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
