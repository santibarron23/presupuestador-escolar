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
    return null;
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

REGLAS IMPORTANTES:
1. La cantidad de cada ítem es el número que aparece ANTES del nombre del producto (ej: "2 blocks" → quantity: 2, item: "blocks de hojas blancas A4 24 hojas").
2. Si el número es parte del producto y no una cantidad (ej: "50 hojas A4 blanco" significa un paquete de 50 hojas, NO comprar 50 unidades), entonces quantity: 1 y el nombre incluye el número (item: "hojas A4 blanco paquete 50").
3. Si una línea tiene múltiples productos separados por guión o coma con sus propias cantidades (ej: "1 FLÚOR, 1 METALIZADO, 1 LUSTRE"), creá un ítem separado para cada uno.
4. Si no hay cantidad especificada, usá 1.
5. Ignorá encabezados, nombres de colegios, grados, fechas y texto irrelevante.

Devolvé SOLO un JSON válido con este formato:
[{"item": "nombre del producto", "quantity": número, "notes": "detalles extra si hay"}]

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

REGLAS IMPORTANTES:
1. La cantidad de cada ítem es el número que aparece ANTES del nombre del producto (ej: "2 blocks" → quantity: 2, item: "blocks de hojas blancas A4 24 hojas").
2. Si el número es parte del producto y no una cantidad (ej: "50 hojas A4 blanco" significa un paquete de 50 hojas, NO comprar 50 unidades), entonces quantity: 1 y el nombre incluye el número (item: "hojas A4 blanco paquete 50"). Esto aplica a ítems como "50 hojas A4", "80 gr", "24 hojas", etc. donde el número describe el contenido del paquete.
3. Si una línea tiene múltiples productos separados por guión, coma o "–" con sus propias cantidades (ej: "PAPEL GLASÉ: 1 FLÚOR, 1 METALIZADO, 1 LUSTRE"), creá un ítem separado para cada uno.
4. Si no hay cantidad especificada, usá 1.
5. Ignorá encabezados, nombres de colegios, grados, fechas y texto irrelevante.

TEXTO DE LA LISTA:
${rawText}

Devolvé SOLO un JSON válido con este formato:
[{"item": "nombre del producto", "quantity": número, "notes": "detalles extra si hay"}]

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
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    return JSON.parse(text);
  } catch (e) {
    throw new Error("No se pudo parsear la respuesta de la IA");
  }
}

// Mapa de sinónimos: términos que usa el usuario → términos que aparecen en catálogo
const SYNONYMS = {
  // ── Papel / hojas ────────────────────────────────────────────────
  "hojas a4": ["resma", "block", "hojas"],
  "hojas blancas": ["resma", "block", "hojas"],
  "hojas de color": ["block", "repuesto", "hojas color"],
  "hojas oficio": ["resma", "oficio", "hojas"],
  "hojas maquina": ["resma", "hojas"],
  "papel a4": ["resma", "block"],
  "resma": ["resma"],
  "folio": ["folio"],
  "folios": ["folio"],
  "folios plasticos": ["folio", "sobre plastico"],
  "papel satinado": ["papel glace", "glasado"],
  "papel carbonico": ["carbonico", "carbon"],
  "papel carbon": ["carbonico", "carbon"],
  "papel afiche": ["afiche"],
  "afiche": ["afiche"],
  "afiches": ["afiche"],
  "papel madera": ["papel madera"],
  "papel cometa": ["seda", "cometa", "seda / cometa"],
  "cometa": ["seda", "cometa", "seda / cometa"],
  "papel crepe": ["crepe"],
  "papel tissue": ["tissue"],
  "cartulina": ["cartulina"],
  "cartulinas": ["cartulina"],

  // ── Papel glasé / lustre / metalizado ────────────────────────────
  "glasé": ["glace"],
  "glase": ["glace"],
  "papel glasé": ["glace"],
  "papel glase": ["glace"],
  "lustre": ["lustre"],
  "metalizado": ["metalizado"],
  "flúor": ["fluo", "fluor"],
  "fluor": ["fluo", "fluor"],
  "fluorescente": ["fluo", "fluor"],
  "papel glase opaco": ["glace lustre"],
  "glase opaco": ["glace lustre"],
  "opaco": ["glace lustre", "lustre"],

  // ── Goma eva ─────────────────────────────────────────────────────
  "goma eva": ["goma eva"],
  "eva lisa": ["goma eva lisa"],
  "eva común": ["goma eva lisa"],
  "eva comun": ["goma eva lisa"],
  "goma eva con brillo": ["goma eva glitter", "goma eva c/glitter"],
  "eva brillo": ["goma eva glitter", "goma eva c/glitter"],
  "eva con brillo": ["goma eva glitter", "goma eva c/glitter"],
  "eva glitter": ["goma eva glitter", "goma eva c/glitter"],
  "con brillo": ["glitter", "c/glitter"],

  // ── Plastificar ──────────────────────────────────────────────────
  "plastificar": ["plastif", "laminad"],
  "plastificado": ["plastif", "laminad"],
  "plancha plastificar": ["plastif"],
  "planchuela plastificar": ["plastif"],
  "maquina plastificar": ["laminador"],

  // ── Lápices ──────────────────────────────────────────────────────
  "lapiz negro": ["lapiz negro"],
  "lápiz negro": ["lapiz negro"],
  "lapiz triangular": ["lapiz", "triangular"],
  "lápiz triangular": ["lapiz", "triangular"],
  "lapiz hb": ["lapiz negro"],
  "lapiz n2": ["lapiz negro"],
  "lapiz n°2": ["lapiz negro"],
  "lapices negros": ["lapiz negro"],
  "lápices negros": ["lapiz negro"],
  "lapices de color": ["lapices de colores", "lapiz color"],
  "lápices de color": ["lapices de colores", "lapiz color"],
  "lapices de colores": ["lapices de colores"],

  // ── Fibrones / marcadores ────────────────────────────────────────
  "fibron": ["fibra", "marcador"],
  "fibrón": ["fibra", "marcador"],
  "fibrones": ["fibra", "marcador"],
  "fibrón negro": ["fibra", "marcador"],
  "fibron negro": ["fibra", "marcador"],
  "fibrón trazo": ["fibra", "marcador"],
  "fibron trazo": ["fibra", "marcador"],
  "felpon": ["fibra", "marcador"],
  "felpón": ["fibra", "marcador"],
  "felpones": ["fibra", "marcador"],
  "marcador negro": ["marcador", "fibra"],
  "marcador permanente": ["marcador", "sharpie", "permanente"],
  "marcador indeleble": ["marcador", "sharpie", "permanente"],
  "fibra indeleble": ["fibra", "marcador", "permanente"],
  "microfibra": ["microfibra", "fibra"],
  "fibra pizarra": ["marcador pizarra"],
  "fibron pizarra": ["marcador pizarra"],
  "marcador pizarra": ["marcador pizarra"],

  // ── Biromes / lapiceras ──────────────────────────────────────────
  "birome": ["boligrafo"],
  "biromes": ["boligrafo"],
  "lapicera": ["lapicera", "boligrafo"],
  "lapicera azul": ["lapicera", "boligrafo"],
  "lapicera tinta": ["lapicera", "boligrafo"],
  "borra tinta": ["borra tinta", "corrector"],

  // ── Cinta adhesiva / transparente ───────────────────────────────
  "cinta transparente": ["cinta adhesiva", "cinta"],
  "cinta adhesiva": ["cinta adhesiva"],
  "cinta de embalar": ["cinta", "embalar"],
  "cinta embalar": ["cinta", "embalar"],
  "scotch": ["cinta adhesiva"],
  "cinta scotch": ["cinta adhesiva"],
  "cinta papel": ["cinta de papel"],
  "cinta bebe": ["cinta"],
  "cinta ancha": ["cinta"],

  // ── Crayones / plastilina ────────────────────────────────────────
  "crayones plasticos": ["crayones", "crayola"],
  "crayones de cera": ["crayones"],
  "crayolas": ["crayones", "crayola"],
  "plastilina": ["plastilina"],
  "plasticina": ["plastilina"],

  // ── Adhesivos / pegamentos ───────────────────────────────────────
  "silicona liquida": ["silicona liquida"],
  "silicona líquida": ["silicona liquida"],
  "silicona en barra": ["silicona"],
  "silicona barra": ["silicona"],
  "barritas de silicona": ["silicona"],
  "voligoma": ["voligoma"],
  "boligoma": ["voligoma", "adhesivo", "cola vinilica"],
  "cola vinilica": ["cola vinilica", "adhesivo"],
  "cola vinílica": ["cola vinilica", "adhesivo"],
  "plasticola": ["plasticola", "adhesivo"],
  "plasticola color": ["plasticola color", "adhesivo color"],
  "plasticola con brillo": ["plasticola", "adhesivo"],

  // ── Pinceles ─────────────────────────────────────────────────────
  "pincel": ["pincel"],
  "pinceles": ["pincel", "pinceles"],
  "set pinceles": ["set de pinceles", "pinceles"],
  "pincel escolar": ["pincel escolar", "set de pinceles"],
  "pincel angular": ["pincel"],

  // ── Carpetas ─────────────────────────────────────────────────────
  "carpeta oficio": ["carpeta oficio"],
  "carpeta tamaño oficio": ["carpeta oficio"],
  "carpeta of": ["carpeta oficio"],
  "carpeta a4": ["carpeta a4"],
  "carpeta n3": ["carpeta"],
  "carpeta nro3": ["carpeta"],
  "carpeta 3 solapas": ["carpeta", "solapas"],
  "carpeta dibujo": ["carpeta dibujo", "carpeta de dibujo"],

  // ── Cuadernos ────────────────────────────────────────────────────
  "cuaderno abc": ["cuaderno abc", "cuaderno rivadavia"],
  "cuaderno anillado": ["cuaderno espiral", "cuaderno espiralado"],
  "cuaderno espiralado": ["cuaderno espiral", "cuaderno espiralado"],
  "cuaderno tapa dura": ["cuaderno tapa dura", "cuaderno td"],
  "cuaderno caligrafia": ["caligrafia"],
  "cuaderno 24 hojas": ["cuaderno 24", "cuaderno 48"],
  "cuaderno 48 hojas": ["cuaderno 48"],
  "cuaderno 100 hojas": ["cuaderno 100", "cuaderno espiralado"],

  // ── Blocks ───────────────────────────────────────────────────────
  "block canson": ["block canson", "block dibujo"],
  "block de dibujo": ["block dibujo", "block de dibujo"],
  "block hojas blancas": ["block hojas", "block a4"],
  "block n5": ["block n5", "block numero 5", "block nro 5"],
  "block nro 5": ["block n5", "block numero 5"],
  "block cartulina": ["block cartulina", "cartulina"],
  "block hojas color": ["block hojas", "hojas color"],
  "block hojas negras": ["block negro", "hojas negras"],
  "repuesto hojas": ["repuesto"],

  // ── Geometría ────────────────────────────────────────────────────
  "tijera": ["tijera"],
  "tijeras": ["tijera"],
  "tijerita": ["tijera"],
  "regla": ["regla"],
  "compas": ["compas"],
  "compás": ["compas"],
  "transportador": ["transportador"],
  "escuadra": ["escuadra"],
  "utiles de geometria": ["transportador", "compas", "escuadra", "regla"],
  "set de geometria": ["transportador", "compas", "escuadra", "regla"],

  // ── Corrector / sacapuntas / borrador ────────────────────────────
  "corrector": ["corrector"],
  "liquid paper": ["corrector"],
  "sacapuntas": ["sacapuntas"],
  "goma de borrar": ["goma", "borrador"],
  "borrador": ["goma", "borrador"],
  "borrador lapiz": ["goma", "borrador"],

  // ── Cartuchera ───────────────────────────────────────────────────
  "cartuchera": ["cartuchera", "canopla"],
  "estuche": ["cartuchera", "canopla"],
  "canopla": ["canopla", "cartuchera"],

  // ── Arte y manualidades ──────────────────────────────────────────
  "tempera": ["tempera"],
  "acuarela": ["acuarela"],
  "lentejuelas": ["lentejuelas"],
  "globos": ["globos tuky", "globo"],
  "globos de colores": ["globos tuky"],
  "globo": ["globos tuky"],
  "palitos de madera": ["palitos de madera"],
  "lienzo": ["lienzo"],
  "nepaco": ["clip"],
  "nepachos": ["clip"],
  "separadores": ["separador"],
  "hojas caligrafia": ["caligrafia"],
  "papel carbon": ["carbonico"],
  "papel carbonico": ["carbonico"],
  "sobre carta": ["sobre manila", "sobre"],
  "sobre manila": ["sobre manila"],
  "mapas": ["mapa"],
  "planisferio": ["planisferio"],
  "diccionario": ["diccionario"],
};

// Normalizar texto: quitar tildes y pasar a minúsculas
function normalize(str) {
  return str.toLowerCase()
    .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
    .replace(/ó/g, 'o').replace(/ú/g, 'u').replace(/ü/g, 'u')
    .replace(/ñ/g, 'n');
}

function expandKeywords(items) {
  const expandedSet = new Set();
  
  // Prefijos a ignorar que Claude suele agregar
  const STRIP_PREFIXES = /^(paq\.?\s+|paquete\s+|caja\s+de\s+|set\s+de\s+|kit\s+de\s+|sobre\s+de\s+|pack\s+de\s+|\d+\s+)/i;

  for (const item of items) {
    // Limpiar prefijos del nombre antes de normalizar
    const cleaned = item.item.replace(STRIP_PREFIXES, '').trim();
    const itemNorm = normalize(cleaned);
    const itemNormFull = normalize(item.item); // también el original completo
    
    // Palabras sueltas (sin tildes), del texto limpio
    for (const word of itemNorm.split(/\s+/)) {
      if (word.length > 2) expandedSet.add(word);
    }
    
    // Frases sinónimas contra el texto limpio Y el original
    for (const [phrase, replacements] of Object.entries(SYNONYMS)) {
      const phraseNorm = normalize(phrase);
      if (itemNorm.includes(phraseNorm) || itemNormFull.includes(phraseNorm)) {
        for (const r of replacements) expandedSet.add(normalize(r));
      }
    }
  }
  
  return Array.from(expandedSet);
}

function preFilterCatalog(items) {
  const keywords = expandKeywords(items);
  
  // Separar keywords de una palabra vs multi-palabra
  const singleKw = keywords.filter(k => !k.includes(' '));
  const multiKw  = keywords.filter(k =>  k.includes(' '));

  const scored = CATALOG.map(p => {
    const nameNorm = normalize(p.name);
    const nameWords = nameNorm.split(/\s+/);
    
    // Keywords de una palabra: comparar contra cada palabra del nombre
    const singleScore = singleKw.filter(k =>
      nameWords.some(w => w.includes(k) || k.includes(w))
    ).length;
    
    // Keywords multi-palabra: comparar contra el nombre completo (x3 peso)
    const multiScore = multiKw.filter(k => nameNorm.includes(k)).length * 3;
    
    return { ...p, score: singleScore + multiScore };
  });

  const filtered = scored
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score);

  // Si hay muy pocos resultados, incluir más del catálogo como fallback
  if (filtered.length < 50) {
    const rest = scored.filter(p => p.score === 0).slice(0, 100 - filtered.length);
    return [...filtered, ...rest].slice(0, 300);
  }

  return filtered.slice(0, 300);
}

async function matchWithCatalog(parsedItems) {
  const relevantCatalog = preFilterCatalog(parsedItems);
  const catalogText = relevantCatalog.map(
    (p) => `ID:${p.id} | SKU:${p.sku || "-"} | "${p.name}" | $${p.price} | stock:${p.stock > 0 ? p.stock : "SIN_STOCK"}`
  ).join("\n");

  const itemsText = parsedItems
    .map((i, idx) => `${idx}. "${i.item}" x${i.quantity}${i.notes ? " (" + i.notes + ")" : ""}`)
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

Para cada ítem de la lista, encontrá el producto más parecido del catálogo. Reglas:

1. PRIORIDAD DE STOCK: Siempre preferí productos con stock disponible. Si hay varias opciones similares, elegí la que tenga stock > 0. Solo matcheá un producto con SIN_STOCK si no existe ninguna otra opción con stock.

2. Buscá por CONCEPTO, no por nombre exacto. Ejemplos de equivalencias válidas:
   - "tijerita" = "tijera" (cualquier tijera del catálogo)
   - "fibron" / "felpon" = "fibra" / "marcador"  
   - "birome" = "boligrafo"
   - "plasticola" = cualquier adhesivo similar
   - "PAQ papel glase opaco" = "Papel Glace Lustre" (el más parecido disponible)
   - "voligoma" / "boligoma" = adhesivo cola vinílica
   - "lapiz negro" = cualquier lapiz negro del catálogo
   - "crayones" = cualquier caja de crayones
   - "tempera" = cualquier tempera disponible

3. Si el ítem tiene un prefijo como "PAQ", "CAJA DE", "SET DE", ignoralo y matcheá el producto principal.

4. La cantidad (quantity) ya viene definida — NO la cambies.

5. El subtotal = unitPrice × quantity.

6. Solo usá matched:false si genuinamente no existe ningún producto similar en el catálogo (ej: "colorante vegetal", "cortante de masa"). Si existe algo parecido con stock, siempre matcheá.

Devolvé SOLO un array JSON válido con este formato exacto, sin texto adicional:
[{"requestedItem":"nombre solicitado","quantity":1,"matched":true,"catalogId":1,"catalogName":"nombre producto","catalogSku":"SKU del producto","unitPrice":1000,"subtotal":1000,"confidence":"high"}]

Si no encontrás un producto similar, usá matched:false, catalogId:null, catalogName:null, catalogSku:null, unitPrice:0, subtotal:0.
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
    let parsedItems;
    if (IMAGE_TYPES.includes(file.mimetype)) {
      parsedItems = await parseListFromImage(file.path, file.mimetype);
    } else {
      const rawText = await extractText(file.path, file.mimetype);
      if (!rawText || rawText.trim().length < 10) {
        return res.status(400).json({ error: "No se pudo leer texto del archivo." });
      }
      parsedItems = await parseListWithAI(rawText);
    }

    const matchedItems = await matchWithCatalog(parsedItems);

    // Enriquecer con slug de URL para link directo a la tienda
    const catalogById = Object.fromEntries(CATALOG.map(p => [p.id, p]));
    matchedItems.forEach(item => {
      if (item.matched && item.catalogId) {
        const prod = catalogById[item.catalogId];
        if (prod) item.catalogSlug = prod.slug || null;
      }
    });

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
      rawText: "",
    });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: "Error procesando la lista: " + err.message });
  } finally {
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
