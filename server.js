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

// ─── PARSEAR PDF COMO IMAGEN CUANDO EL TEXTO SALE GARBLED ──────────
async function parseListFromPdfVision(pdfPath) {
  // Convertir PDF a imagen usando pdf-poppler o similar
  // Como fallback: leer el PDF en base64 y enviarlo como documento a Claude
  const pdfBuffer = fs.readFileSync(pdfPath);
  const base64 = pdfBuffer.toString("base64");

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: base64 },
            },
            {
              type: "text",
              text: `Este es un PDF de una lista de útiles escolares. Puede ser una tabla compleja con múltiples columnas por grado.
Leé TODOS los productos únicos que aparecen en la lista, incluyendo los de todas las columnas/grados.

REGLAS IMPORTANTES:
1. Si es una tabla con columnas por grado (1°, 2°, 3°, etc.), listá cada producto UNA SOLA VEZ con quantity: 1.
2. Si hay cantidades específicas indicadas (ej: "2 carpetas"), usá esa cantidad.
3. Si el número es parte del producto (ej: "50 hojas A4"), quantity: 1 e incluí el número en el nombre.
4. Si una línea tiene múltiples productos separados, creá un ítem por cada uno.
5. Ignorá encabezados, nombres de colegios, grados, fechas, precios y texto irrelevante.
6. Ignorá artículos de higiene (jabón, papel higiénico, etc.) y de educación física (palo hockey, etc.).

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

  const pdfRespText = response.data.content[0].text.trim();
  const pdfJsonStr = pdfRespText.replace(/```json|```/g, "").trim();
  return JSON.parse(pdfJsonStr);
}

// ─── PARSEAR LISTA DESDE IMAGEN (visión de Claude) ────────────────
async function parseListFromImage(filePath, mimeType) {
  const imageBuffer = fs.readFileSync(filePath);
  const base64 = imageBuffer.toString("base64");

  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
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
      max_tokens: 4000,
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
  // ── Papel / hojas sueltas ────────────────────────────────────────
  "hojas a4": ["resma a7", "resma a4", "resma", "hojas a4"],
  "hojas de maquina a4": ["resma a4", "resma a7", "hoja a4 blanca", "hojas a4"],
  "hojas de máquina a4": ["resma a4", "resma a7", "hoja a4 blanca", "hojas a4"],
  "hojas maquina a4 blancas": ["hoja a4 blanca", "resma a4", "resma a7"],
  "hojas maquina a4 color": ["resma a4 luma color", "luma color", "block n5 luma color"],
  "hojas de maquina a4 blancas": ["hoja a4 blanca", "resma a4", "resma a7"],
  "hojas de maquina a4 de colores": ["resma a4 luma color", "luma color", "block n5 luma color"],
  "hojas de maquina a4 colores": ["resma a4 luma color", "luma color"],
  "hojas a4 blancas": ["hoja a4 blanca", "resma a4", "resma a7"],
  "hojas a4 de colores": ["resma a4 luma color", "luma color", "resma a4 210"],
  "hojas a4 color": ["resma a4 luma color", "luma color", "resma a4 210"],
  "hojas blancas": ["resma", "hojas"],
  "hojas de color": ["hojas color", "block"],
  "hojas a4 color": ["resma color", "hojas color", "block"],
  "hojas oficio": ["resma", "oficio", "hojas"],
  "hojas oficio color": ["hojas color", "oficio"],
  "hojas maquina": ["resma", "hojas"],
  "papel a4": ["resma", "block"],
  "resma": ["resma"],
  "folio": ["folio"],
  "folios": ["folio"],
  "folios plasticos": ["folio", "sobre plastico"],
  "folio a4": ["folio"],
  "papel satinado": ["papel glace", "glasado"],
  "papel carbonico": ["carbonico", "carbon"],
  "papel carbon": ["carbonico", "carbon"],
  "papel calcar": ["calcar", "repuesto de calcar", "repuesto calcar"],
  "papel celofan": ["celofan", "acetato"],
  "papel acetato": ["acetato"],
  "tapa acetato": ["acetato", "tapa"],

  // ── Papel afiche / madera / cometa / crepe ───────────────────────
  "papel afiche": ["papel afiche", "afiche", "block afiche", "block de dibujo n° 5 afiche", "block dibujo n° 5 afiche"],
  "afiche": ["papel afiche", "afiche", "block de dibujo n° 5 afiche"],
  "afiches": ["papel afiche", "afiche", "block de dibujo n° 5 afiche"],
  "afiches color": ["papel afiche", "afiche", "block de dibujo n° 5 afiche"],
  "block afiche": ["block afiche", "afiche", "block de dibujo n° 5 afiche"],
  "papel madera": ["papel madera"],
  "papel cometa": ["seda", "cometa", "seda / cometa", "barrilete"],
  "papel barrilete": ["seda", "cometa", "seda / cometa", "barrilete"],
  "cometa": ["seda", "cometa", "seda / cometa"],
  "papel crepe": ["crepe"],
  "papel crepé": ["crepe"],
  "crepe": ["crepe"],
  "crepé": ["crepe"],
  "papel tissue": ["tissue"],
  "papel araña": ["araña", "volantin"],

  // ── Papel glasé / lustre / metalizado ────────────────────────────
  "glasé": ["glace"],
  "glase": ["glace"],
  "papel glasé": ["glace"],
  "papel glase": ["papel glace", "glace"],
  "papel glasé": ["papel glace", "glace"],
  "papel glace fluo": ["papel glace fluo surtido", "glace fluo"],
  "papel glasé fluo": ["papel glace fluo surtido", "glace fluo"],
  "papel glace fluor": ["papel glace fluo surtido", "glace fluo"],
  "papel glasé fluor": ["papel glace fluo surtido", "glace fluo"],
  "papel glace mate": ["papel glace lustre", "glace lustre"],
  "papel glasé mate": ["papel glace lustre", "glace lustre"],
  "papel glace metalizado": ["papel glace metalizado surtido", "glace metalizado"],
  "papel glasé metalizado": ["papel glace metalizado surtido", "glace metalizado"],
  "lustre": ["lustre"],
  "metalizado": ["metalizado"],
  "flúor": ["fluo", "fluor"],
  "fluor": ["fluo", "fluor"],
  "fluorescente": ["fluo", "fluor"],
  "papel glase opaco": ["glace lustre"],
  "papel glase comun": ["glace lustre"],
  "papel glase común": ["glace lustre"],
  "glase opaco": ["glace lustre"],
  "opaco": ["glace lustre", "lustre"],
  "papel glase lustre": ["glace lustre"],

  // ── Cartulina ───────────────────────────────────────────────────
  "cartulina": ["cartulina"],
  "cartulinas": ["cartulina"],
  "cartulina lisa": ["cartulina lisa"],
  "cartulinas lisas": ["cartulina lisa"],
  "cartulina": ["cartulina lisa varios colores", "cartulina lisa", "cartulina comun"],
  "cartulina color": ["cartulina lisa varios colores", "cartulina lisa"],
  "cartulina color claro": ["cartulina lisa varios colores"],
  "cartulinas color": ["cartulina lisa varios colores", "cartulina lisa"],
  "cartulina fantasía": ["cartulina fantasia", "block cartulina"],
  "cartulina fantasia": ["cartulina fantasia", "block cartulina"],

  // ── Goma eva ─────────────────────────────────────────────────────
  "goma eva": ["goma eva"],
  "eva lisa": ["goma eva lisa"],
  "eva común": ["goma eva lisa"],
  "eva comun": ["goma eva lisa"],
  "goma eva con brillo": ["goma eva glitter", "goma eva c/glitter"],
  "goma eva brillito": ["goma eva glitter", "goma eva c/glitter"],
  "eva brillo": ["goma eva glitter", "goma eva c/glitter"],
  "eva con brillo": ["goma eva glitter", "goma eva c/glitter"],
  "eva con brillos": ["goma eva glitter", "goma eva c/glitter"],
  "eva glitter": ["goma eva glitter", "goma eva c/glitter"],
  "eva gibré": ["goma eva glitter", "goma eva c/glitter"],
  "eva gibre": ["goma eva glitter", "goma eva c/glitter"],
  "goma eva fantasia": ["goma eva fantasia", "goma eva"],
  "goma eva textura": ["goma eva"],
  "goma eva toalla": ["goma eva"],
  "con brillo": ["glitter", "c/glitter"],

  // ── Plastificar / contact ────────────────────────────────────────
  "plastificar": ["contact", "contacto"],
  "plastificado": ["contact", "contacto"],
  "plancha plastificar": ["contact", "contacto"],
  "plancha de plastificar": ["contact", "contacto"],
  "plancha contac": ["contact", "contacto"],
  "plastificar en frio": ["contact transparente"],
  "papel contact": ["contact"],
  "contac": ["contact"],

  // ── Lápices ──────────────────────────────────────────────────────
  "lapiz negro": ["lapiz negro"],
  "lápiz negro": ["lapiz negro"],
  "lapiz grafito": ["lapiz negro"],
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
  "lapices de colores fluo": ["lapiz color fluo", "lapiz color neon", "lapiz fluo"],
  "lapices fluo": ["lapiz color fluo", "lapiz color neon", "lapiz fluo"],
  "lápices flúo": ["lapiz color fluo", "lapiz color neon", "lapiz fluo"],

  // ── Fibrones / marcadores ────────────────────────────────────────
  "fibron": ["fibra", "marcador"],
  "fibrón": ["fibra", "marcador"],
  "fibrones": ["fibra", "marcador"],
  "fibra": ["fibra", "marcador"],
  "fibras": ["fibra", "marcador"],
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
  "fibra indeleble": ["fibra", "marcador", "permanente", "sharpie"],
  "fibron indeleble": ["fibra", "marcador", "permanente", "sharpie"],
  "fibrón indeleble": ["fibra", "marcador", "permanente", "sharpie"],
  "microfibra": ["microfibra", "fibra"],
  "fibra pizarra": ["marcador pizarra", "edding pizarra", "marcador p/ pizarra"],
  "fibron pizarra": ["marcador pizarra", "edding pizarra", "marcador p/ pizarra", "edding 160"],
  "fibrón pizarra": ["marcador pizarra", "edding pizarra", "marcador p/ pizarra", "edding 160"],
  "marcador pizarra": ["marcador pizarra", "edding pizarra", "marcador p/ pizarra", "edding 160"],
  "edding pizarra": ["edding 160", "marcador pizarra"],
  "fibron al agua": ["marcador pizarra", "fibra"],
  "fibron fluo": ["resaltador", "marcador fluo"],
  "fibrón flúor": ["resaltador", "marcador fluo"],
  "fibras gruesas": ["fibra", "marcador", "trazo grueso"],
  "caja de fibras": ["fibra", "marcador"],
  "fibras largas": ["fibra", "marcador"],
  "marcador fluo": ["resaltador"],
  "resaltador": ["resaltador"],
  "resaltadores": ["resaltador"],

  // ── Biromes / lapiceras ──────────────────────────────────────────
  "birome": ["boligrafo"],
  "biromes": ["boligrafo"],
  "lapicera": ["lapicera", "boligrafo"],
  "lapicera azul": ["lapicera", "boligrafo"],
  "lapicera tinta": ["lapicera", "boligrafo"],
  "lapicera borrable": ["lapicera borrable", "boligrafo borrable"],
  "lapicera fuente": ["lapicera fuente", "lapicera"],
  "borra tinta": ["borra tinta", "corrector"],
  "borratinta": ["borra tinta", "corrector"],

  // ── Cinta adhesiva / transparente ───────────────────────────────
  "cinta transparente": ["cinta adhesiva", "cinta"],
  "cinta adhesiva": ["cinta adhesiva"],
  "cinta de embalar": ["cinta", "embalar"],
  "cinta embalar": ["cinta", "embalar"],
  "scotch": ["cinta adhesiva"],
  "cinta scotch": ["cinta adhesiva"],
  "cinta papel": ["cinta de papel auca", "cinta de papel"],
  "cinta de papel": ["cinta de papel auca", "cinta papel"],
  "cinta de papel gruesa": ["cinta de papel auca", "cinta papel"],
  "cinta papel gruesa": ["cinta de papel auca", "cinta papel"],
  "cinta bebe": ["cinta"],
  "cinta ancha": ["cinta ancha", "cinta papel ancha"],
  "cinta papel ancha": ["cinta ancha", "cinta papel"],

  // ── Crayones / plastilina ────────────────────────────────────────
  "crayones": ["crayones"],
  "crayon": ["crayones"],
  "crayones plasticos": ["crayones"],
  "crayones de cera": ["crayones"],
  "crayones gruesos": ["crayones"],
  "crayones fluo": ["crayones"],
  "crayones fluor": ["crayones"],
  "crayones flúor": ["crayones"],
  "crayones gel": ["crayones"],
  "crayones con glitter": ["crayones"],
  "crayolas": ["crayones", "crayola"],
  "plastilina": ["plastilina"],
  "plastilinas": ["plastilina"],
  "plasticina": ["plastilina"],

  // ── Tizas ────────────────────────────────────────────────────────
  "tiza": ["tiza"],
  "tizas": ["tiza"],
  "tizas blancas": ["tiza"],
  "tizas de color": ["tiza color", "tiza"],
  "tizas color": ["tiza color", "tiza"],
  "caja de tizas": ["tiza color x12", "tiza color", "tiza"],
  "caja tizas": ["tiza color", "tiza"],
  "tizas": ["tiza color", "tiza"],
  "tizas escolares": ["tiza color", "tiza"],

  // ── Adhesivos / pegamentos ───────────────────────────────────────
  "silicona liquida": ["silicona liquida"],
  "silicona líquida": ["silicona liquida"],
  "silicona en barra": ["barra adhesiva de silicona", "silicona"],
  "silicona barra": ["barra adhesiva de silicona", "silicona"],
  "barritas de silicona": ["barra adhesiva de silicona"],
  "barrita de silicona": ["barra adhesiva de silicona"],
  "barras de silicona": ["barra adhesiva de silicona"],
  "barrita silicona": ["barra adhesiva de silicona"],
  "silicona gruesa": ["barra adhesiva de silicona"],
  "silicona fria": ["barra adhesiva de silicona", "silicona"],
  "voligoma": ["voligoma"],
  "voligoma pequeña": ["voligoma"],
  "boligoma": ["voligoma", "adhesivo", "cola vinilica"],
  "cola vinilica": ["cola vinilica", "adhesivo"],
  "cola vinílica": ["cola vinilica", "adhesivo"],
  "plasticola": ["plasticola", "adhesivo"],
  "plasticola color": ["plasticola color", "adhesivo color"],
  "plasticola con brillo": ["plasticola", "adhesivo"],
  "plasticola blanca": ["plasticola", "adhesivo"],

  // ── Tempera / pintura ────────────────────────────────────────────
  "tempera": ["tempera"],
  "témpera": ["tempera"],
  "pote de tempera": ["tempera"],
  "tempera con brillo": ["tempera", "glitter"],
  "tempera glitter": ["tempera", "glitter"],
  "tempera metalizada": ["tempera"],

  // ── Acuarela ─────────────────────────────────────────────────────
  "acuarela": ["acuarela"],
  "acrilico": ["tempera", "acrilica", "acrilico"],
  "acrílico": ["tempera", "acrilica", "acrilico"],
  "pintura acrilica": ["acrilica", "acrilico", "tempera"],
  "pote acrilico": ["tempera", "acrilica"],
  "acuarelas": ["acuarela"],
  "paleta acuarela": ["acuarela"],
  "paleta de acuarelas": ["acuarela"],

  // ── Pinceles / rodillo ───────────────────────────────────────────
  "pincel": ["pincel"],
  "pinceles": ["pincel"],
  "set pinceles": ["set de pinceles", "pinceles"],
  "pincel escolar": ["pincel"],
  "pincel angular": ["pincel angular", "pincel"],
  "pincel chato": ["pincel chato"],
  "pincel redondo": ["pincel redondo", "pincel"],
  "pinceleta": ["pincel", "pinceleta"],
  "rodillo": ["rodillo"],

  // ── Carpetas ─────────────────────────────────────────────────────
  "carpeta oficio": ["carpeta oficio"],
  "carpeta tamaño oficio": ["carpeta oficio"],
  "carpeta of": ["carpeta oficio"],
  "carpeta a4": ["carpeta a4"],
  "carpeta n3": ["carpeta"],
  "carpeta nro3": ["carpeta"],
  "carpeta 3 solapas": ["carpeta", "solapas"],
  "carpeta tres solapas": ["carpeta", "solapas"],
  "carpeta dibujo": ["carpeta dibujo", "carpeta de dibujo"],
  "carpeta n5": ["carpeta"],
  "carpeta plastica": ["carpeta", "plastica"],
  "anillos para carpeta": ["anillos", "anillo"],

  // ── Cuadernos ────────────────────────────────────────────────────
  "cuaderno abc": ["cuadernos esp.abc rivadavia", "cuaderno esp. abc rivadavia", "abc rivadavia"],
  "cuaderno abc rivadavia": ["cuadernos esp.abc rivadavia", "cuaderno esp. abc rivadavia"],
  "cuaderno rivadavia": ["cuadernos esp.abc rivadavia", "cuaderno esp. abc rivadavia"],
  "cuaderno espiral abc": ["cuadernos esp.abc rivadavia", "cuaderno esp. abc rivadavia"],
  "cuaderno abc 100 hojas": ["cuaderno esp. abc rivadavia x100"],
  "cuaderno abc 60 hojas": ["cuadernos esp.abc rivadavia aula universal x60"],
  "cuaderno espiral abc 100": ["cuaderno esp. abc rivadavia x100"],
  "cuaderno anillado": ["cuaderno espiral", "cuaderno espiralado"],
  "cuaderno espiralado": ["cuaderno espiral", "cuaderno espiralado"],
  "cuaderno tapa dura": ["cuaderno tapa dura", "cuaderno td"],
  "cuaderno caligrafia": ["caligrafia"],
  "cuaderno 24 hojas": ["cuaderno 24"],
  "cuaderno 48 hojas": ["cuaderno 48"],
  "cuaderno 100 hojas": ["cuaderno 100", "cuaderno espiralado"],
  "cuaderno comunicaciones": ["cuaderno comunicaciones", "cuaderno comunicacion"],
  "libreta comunicacion": ["cuaderno comunicaciones", "comunicaciones triunfante"],
  "cuaderno de comunicaciones": ["cuaderno de comunicaciones triunfante", "comunicaciones triunfante", "comunicaciones zeta"],

  // ── Blocks ───────────────────────────────────────────────────────
  "block canson": ["block canson", "block dibujo"],
  "block de dibujo": ["block dibujo", "block de dibujo"],
  "block hojas blancas": ["block hojas", "block a4"],
  "block n5": ["block n5", "block nene", "block dibujo"],
  "block nro 5": ["block n5", "block nene"],
  "block nene": ["block nene", "block n5"],
  "block cartulina": ["block cartulina", "cartulina"],
  "block hojas color": ["block hojas", "hojas color"],
  "block hojas negras": ["block negro", "hojas negras"],
  "repuesto hojas": ["repuesto"],
  "hojas de carpeta": ["repuesto"],
  "block papel afiche": ["block afiche", "afiche"],

  // ── Geometría ────────────────────────────────────────────────────
  "tijera": ["tijera"],
  "tijeras": ["tijera"],
  "tijerita": ["tijera"],
  "regla": ["regla"],
  "regla flexible": ["regla"],
  "regla rigida": ["regla"],
  "compas": ["compas"],
  "compás": ["compas"],
  "transportador": ["transportador", "escuadra"],
  "escuadra": ["escuadra"],
  "utiles de geometria": ["transportador", "compas", "escuadra", "regla"],
  "set de geometria": ["transportador", "compas", "escuadra", "regla"],
  "juego de geometria": ["transportador", "compas", "escuadra", "regla"],

  // ── Corrector / sacapuntas / borrador ────────────────────────────
  "corrector": ["corrector"],
  "liquid paper": ["corrector"],
  "sacapuntas": ["sacapuntas"],
  "caja de sacapuntas": ["sacapuntas"],
  "afilador": ["sacapuntas"],
  "goma de borrar": ["goma", "borrador"],
  "borrador": ["goma", "borrador"],
  "borrador lapiz": ["goma", "borrador"],

  // ── Cartuchera ───────────────────────────────────────────────────
  "cartuchera": ["cartuchera", "canopla"],
  "estuche": ["cartuchera", "canopla"],
  "canopla": ["canopla", "cartuchera"],

  // ── Arte / manualidades ──────────────────────────────────────────
  "lentejuelas": ["lentejuelas"],
  "globos": ["globos tuky", "globo"],
  "globos de colores": ["globos tuky"],
  "globo": ["globos tuky"],
  "palitos de madera": ["palitos de madera"],
  "lienzo": ["lienzo"],
  "nepaco": ["clip"],
  "nepachos": ["clip"],

  // ── Varios ───────────────────────────────────────────────────────
  "separadores": ["separador"],
  "hojas caligrafia": ["caligrafia"],
  "sobre carta": ["sobre manila", "sobre"],
  "sobre manila": ["sobre manila"],
  "mapas": ["mapas politico", "mapas fisico", "mapa mural"],
  "mapa": ["mapas politico", "mapas fisico", "mapa mural"],
  "mapa n3": ["mapas politico n°3", "mapas fisico n°3"],
  "mapas n3": ["mapas politico n°3", "mapas fisico n°3"],
  "mapa politico": ["mapas politico"],
  "mapas politicos": ["mapas politico"],
  "mapa fisico": ["mapas fisico"],
  "mapas fisicos": ["mapas fisico"],
  "mapa argentina": ["mapas politico", "mapa mural argentina"],
  "mapa argentina division politica": ["mapas politico"],
  "argentina division politica": ["mapas politico"],
  "division politica argentina": ["mapas politico"],
  "mapa continente americano": ["mapas politico", "mapas fisico", "mapa mural america"],
  "continente americano politico": ["mapas politico"],
  "continente americano fisico": ["mapas fisico"],
  "america politico": ["mapas politico"],
  "america fisico": ["mapas fisico"],
  "planisferio": ["mapas politico", "mapas fisico", "mapa mural planisferio"],
  "mapa planisferio": ["mapas politico", "mapas fisico", "mapa mural planisferio"],
  "diccionario": ["diccionario"],
  "calculadora": ["calculadora"],
  "agenda": ["agenda"],

  // ── Nuevos términos 2026 (batch 3) ──────────────────────────────

  // Blocks El Nene / Éxito — nombres exactos del catálogo
  "block exito n5 blanco": ["block exito nat", "exito nat", "block exito n5"],
  "block éxito n5 blanco": ["block exito nat", "exito nat"],
  "block exito n5 color": ["block exito", "exito n5", "block nene color"],
  "block el nene negro": ["block el nene negro", "el nene negro"],
  "block el nene afiche": ["block el nene afiche", "nene afiche", "block de dibujo n° 5 afiche"],
  "block el nene kraft": ["papel madera", "kraft"],
  "block kraft": ["papel madera"],
  "papel araña color": ["papel araña", "papel seda", "cartulina lisa"],
  "papel araña": ["papel araña", "cartulina lisa"],

  // Folios / plásticos
  "folio n3": ["folio", "folios a4 luma", "sobre plastico"],
  "folio nro 3": ["folio", "folios a4 luma"],
  "folio plastico n3": ["folio", "folios a4 luma"],
  "folios plasticos n3": ["folio", "folios a4 luma"],
  "carpeta en l transparente": ["carpeta tapa cristal", "carpeta transparente"],
  "carpeta l transparente": ["carpeta tapa cristal"],

  // Biromes / lapiceras
  "birome roja": ["boligrafo bic cristal", "bic cristal fashion"],
  "birome negra": ["boligrafo bic cristal", "bic cristal"],
  "birome azul": ["boligrafo bic cristal", "bic cristal"],
  "biromes de colores": ["boligrafo bic cristal fashion", "boligrafo color"],
  "lapicera frixion": ["lapicera borrable", "boligrafo borrable gel bic"],
  "lapicera tinta borrable": ["lapicera borrable", "boligrafo borrable gel bic"],
  "lapicera a cartucho": ["cartucho pelikan", "cartucho parker", "lapicera fuente"],
  "cartucho azul lavable": ["cartucho pelikan", "cartucho pelikan corto azul", "cartucho parker"],
  "cartucho tinta azul": ["cartucho pelikan corto azul", "cartucho pelikan"],

  // Fibras / marcadores
  "fibra trazo grueso": ["fibra", "trazo grueso"],
  "fibras colores punta gruesa": ["fibra", "trazo grueso"],
  "lapices gioto": ["lapices de colores", "lapiz color"],

  // Mapas adicionales (todos van a MAPAS Politico/Fisico)
  "mapa salta politico": ["mapas politico"],
  "mapa salta fisico": ["mapas fisico"],
  "mapa de salta": ["mapas politico", "mapas fisico"],
  "mapa europa": ["mapas politico"],
  "mapa america del sur": ["mapas politico", "mapas fisico"],
  "mapa cromo planisferio": ["mapa mural planisferio", "mapas politico"],

  // Repuestos  
  "repuesto 488 hojas": ["repuesto rivadavia", "repuesto triunfante"],
  "repuesto rayado 488": ["repuesto rivadavia", "repuesto triunfante"],
  "repuesto cuadriculado 200": ["repuesto rivadavia", "repuesto"],
  "block caligrafía n3": ["caligrafia", "block caligrafia"],
  "block caligrafía": ["caligrafia", "block caligrafia"],

  // Varios útiles
  "plastico para forrar": ["plastico forrar", "contact", "plasticola"],
  "papel azul para forrar": ["papel araña", "cartulina lisa"],
  "etiquetas nombre": ["etiqueta"],
  "bitacora 12 hojas a4 140grs": ["cuaderno espiral", "bitacora"],
  "acrilico 200ml": ["tempera", "acrilico"],
  "acrilico 60ml": ["tempera", "acrilico"],
  "silicona liquida": ["cola silicona", "adhesivo silicona"],
  "pincel escolar": ["pincel"],

  // Descartables y artículos de higiene del jardín
  // NOTA: Estos no están en catálogo. Claude debe indicar "consultar con asesor"
  "flauta dulce": [],
  "papel film": [],
  "rociador": [],
  "esponja": [],
  "limpiapipas": [],
  "vasos descartables": [],
  "platos descartables": [],
  "tenedores descartables": [],
  "cucharillas descartables": [],
  "bandejas descartables": [],
  "gotero pipeta": [],
  "jeringa": [],
  "bicarbonato": [],
  "fecula de maiz": [],
  "cremor tartaro": [],
  "toallitas humedas": [],
  "espuma de afeitar": [],
  "palo hockey": [],
  "protector bucal": [],
  "canilleras": [],

  // ── Nuevos términos 2026 ─────────────────────────────────────────
  // Fibras / marcadores
  "marca todo": ["pelikan 420", "marcadores pelikan"],
  "marcatodo": ["pelikan 420", "marcadores pelikan"],
  "fibron pastel": ["resaltador", "marcadores pastel"],
  "fibrón pastel": ["resaltador", "marcadores pastel"],
  "fibron fluo": ["resaltador"],
  "fibrón flúo": ["resaltador"],
  "microfibra para mapas": ["microfibra", "stabilo"],
  "microfibra negra": ["microfibra"],
  "portamina": ["portaminas", "portamina"],

  // Tempera / pintura
  "plasticola fluo": ["plasticola"],
  "plasticola flúo": ["plasticola"],
  "tempera metalizada": ["tempera"],
  "témpera metalizada": ["tempera"],
  "tempera en barra": ["tempera solida", "marcador tempera solida"],
  "témpera en barra": ["tempera solida"],
  "tempera barra": ["tempera solida", "marcador tempera solida"],

  // Cartulina flúo
  "cartulina fluo": ["cartulina lisa", "cartulina"],
  "cartulina flúo": ["cartulina lisa", "cartulina"],
  "cartulina fluorescente": ["cartulina lisa", "cartulina"],

  // Hojas / repuestos
  "hojas oficio color": ["folio oficio", "folio"],
  "hojas oficio de color": ["folio oficio", "folio"],
  "repuesto canson n5 blanco": ["repuesto de dibujo n 5 blanco", "repuesto dibujo"],
  "repuesto canson n5 color": ["repuesto de dibujo n 5 color", "repuesto dibujo"],
  "repuesto canson n5 negro": ["repuesto de dibujo n 5 negro"],
  "repuesto n5 blanco": ["repuesto de dibujo n 5 blanco", "repuesto dibujo"],
  "repuesto n5 color": ["repuesto de dibujo n 5 color", "repuesto dibujo"],
  "repuesto n5 negro": ["repuesto de dibujo n 5 negro"],
  "block canson n5 blanco x8": ["repuesto de dibujo n 5 blanco"],
  "block canson n5 color x8": ["repuesto de dibujo n 5 color"],
  "block canson n5 negro x8": ["repuesto de dibujo n 5 negro"],

  // Cuadernos
  "cuaderno tapa blanda 24 hojas": ["cuaderno caligrafia", "cuaderno 24"],
  "cuaderno 24 hojas tapa blanda": ["cuaderno caligrafia", "cuaderno 24"],
  "cuaderno abc 48 hojas": ["cuadernos esp.abc rivadavia", "cuaderno abc"],
  "cuaderno abc rivadavia 48 hojas": ["cuadernos esp.abc rivadavia aula universal x60"],

  // Carpetas
  "carpeta dibujo n5": ["carpeta tapa cristal", "carpeta"],
  "carpeta oficio n5 dibujo": ["carpeta tapa cristal", "carpeta"],
  "carpeta con elastico solapas": ["carpeta solapas", "carpeta 3 solapas"],
  "carpeta elastico solapas": ["carpeta solapas", "carpeta 3 solapas"],
  "bibliorato a4": ["carpeta tapa cristal", "bibliorato"],

  // Lapicera violeta / color
  "lapicera violeta": ["lapicera", "boligrafo"],
  "lapicera color violeta": ["lapicera", "boligrafo"],

  // Higiene (productos de higiene: aunque no están en el catálogo, Claude puede sugerirlo)
  "papel higienico": ["papel higienico"],
  "jabon liquido": ["jabon"],
  "alcohol en gel": ["alcohol gel", "alcohol"],
  "rollo de cocina": ["papel cocina"],
  "rollo papel cocina": ["papel cocina"],
  "servilletas": ["servilleta"],

  // Artículos especiales / manualidades
  "aro metalico": ["carpeta", "anillo"],
  "aros metalicos": ["carpeta", "anillo"],
  "broche mariposa": ["broche grap", "broche"],
  "broches mariposa": ["broche grap"],
  "cinta razo": ["cinta"],
  "cinta de razo": ["cinta"],
  "cinta raso": ["cinta"],
  "papel celofan": ["acetato transparente", "acetato"],
  "bloque canson cartulinas entretenidas": ["block cartulina entretenida"],
  "cartulinas entretenidas": ["block cartulina entretenida"],
  "juego de mesa": ["juego didactico", "juego de geometria"],
  "libreta indice": ["libreta"],
  "libreta indice alfabetico": ["libreta"],

  // ── Tecnología ───────────────────────────────────────────────────
  "pendrive": ["pendrive"],
  "pen drive": ["pendrive"],
  "memoria usb": ["pendrive"],

  // ── Hojas de carpeta / repuesto ──────────────────────────────────
  "block hojas canson n3": ["repuesto", "hojas rayadas n3", "hojas cuadriculadas n3"],
  "block canson n3": ["repuesto", "hojas n3"],
  "block de hojas n3": ["repuesto", "hojas n3"],
  "hojas de carpeta n3": ["repuesto", "hojas n3"],
  "hojas n3": ["repuesto n3", "hojas rayadas n3"],
  "block n3": ["repuesto n3", "repuesto"],
  "block hojas canson n5": ["repuesto n5", "repuesto dibujo"],
  "hojas rayadas": ["repuesto", "hojas rayadas"],
  "hojas cuadriculadas": ["repuesto", "hojas cuadriculadas"],

  // ── Tinta (contexto escolar = borratinta / lapicera) ─────────────
  "tinta": ["borratinta", "borra tinta", "lapicera"],
  "borra tinta": ["borratinta", "borra tinta"],
  "borratinta": ["borratinta", "borra tinta"],

  // ── Sacapuntas ───────────────────────────────────────────────────
  "sacapuntas": ["sacapuntas"],
  "caja de sacapuntas": ["sacapuntas"],
  "afilador": ["sacapuntas"],
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
    // Parte antes del "+" o "/" para detectar producto principal vs accesorio incluido
    const primaryName = nameNorm.split(/[+\/]/)[0].trim();
    const primaryWords = primaryName.split(/\s+/);
    
    // Keywords de una palabra: comparar contra cada palabra del nombre
    const singleScore = singleKw.filter(k =>
      nameWords.some(w => w.includes(k) || k.includes(w))
    ).length;
    
    // Keywords multi-palabra: comparar contra el nombre completo (x3 peso)
    const multiScore = multiKw.filter(k => nameNorm.includes(k)).length * 3;

    // Bonus x2 si el keyword aparece en la parte PRINCIPAL del nombre (antes del +)
    // Esto evita que "sacapuntas" matchee "lápices + sacapuntas" antes que "Sacapuntas Maped"
    const primaryBonus = singleKw.filter(k =>
      primaryWords.some(w => w.includes(k) || k.includes(w))
    ).length;
    
    // Bonus adicional si el producto empieza con el keyword (producto principal)
    const startsWithBonus = singleKw.some(k => nameNorm.startsWith(k)) ? 3 : 0;
    
    return { ...p, score: singleScore + multiScore + primaryBonus + startsWithBonus };
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
   - "papel afiche" / "afiches" = "Block De Dibujo N° 5 Afiche El Nene" u otro afiche disponible (NO "Bandera de Argentina", NO "Encastre Mapa")
   - "mapa Argentina" / "mapa división política" = buscar "MAPAS POLITICO" o "Mapa Mural" — NUNCA "Bandera de Argentina"
   - "mapa planisferio" / "planisferio" = "Mapa Mural Planisferio" — NUNCA confundir con bandera
   - "mapa continente americano" = "Mapa Mural America" 
   - "cuaderno ABC" / "cuaderno espiral ABC 100 hojas" = "CUADERNO ESP. ABC RIVADAVIA x100 HOJAS" o "CUADERNOS ESP.ABC RIVADAVIA" — NO cuadernos Oxford ni Norpac
   - "cuaderno de comunicaciones" = "Cuaderno De Comunicaciones Triunfante" (stock:110) — NO ignorar este producto
   - "fibron para pizarra" / "fibrón pizarra" = "Marcador Edding 160 P/Pizarra" o "Marcador P/ Pizarra Recargable TRABI"
   - "block canson N°3" / "hojas color N°3" = "Repuesto" de hojas para carpeta N3 (ej: REPUESTO RIVADAVIA N3, REPUESTO TRIUNFANTE N3)
   - "sacapuntas" = "Sacapuntas Para Zurdos Igloo Maped" (el único con stock)
   - "tinta" en contexto escolar = "Borratinta Pelikan" o lapicera con tinta
   - "diccionario" = cualquier diccionario del catálogo (español, inglés, sinónimos)
   - "pendrive" = "Pendrive KINGSTON" u otro pendrive disponible
   - "papel calcar" / "sobre de papel calcar" = "Repuesto de Calcar" (N°3 o N°5 Luma/Iglu)
   - "pote de acrílico" / "pintura acrílica" = témpera u otro tipo de pintura disponible (NO marcadores acrílicos)
   - "ojalillos" / "plancha de ojalillos" = "Ojalillos Escolares" (buscar en catálogo)
   - REGLA CRÍTICA: Si el usuario pide "mapa" o "planisferio", NUNCA devolver "bandera" aunque ambas tengan "argentina"
   - REGLA CRÍTICA: Si el usuario pide "cuaderno ABC" o "cuaderno espiral ABC 100 hojas", devolver SIEMPRE "CUADERNO ESP. ABC RIVADAVIA x100 HOJAS" o "CUADERNOS ESP.ABC RIVADAVIA AULA UNIVERSAL x60 HOJAS" — NO cuadernos Oxford, Norpac, ni otros
   - REGLA CRÍTICA: Los mapas en catálogo son GENÉRICOS: "MAPAS Politico N°3" (stock:67) y "MAPAS Fisico N°3" (stock:77). No hay mapas específicos por región (ni planisferio N°3 ni continente americano N°3 separados). Cuando pidan "mapa planisferio N°3", "mapa Argentina división política N°3", o "mapa continente americano N°3", devolver "MAPAS Politico N°3" o "MAPAS Fisico N°3" según corresponda, e indicar al usuario que en la descripción del producto puede seleccionar la región
   - REGLA CRÍTICA: "cartulina color claro" = "Cartulina Lisa Varios Colores" (stock:69)
   - "marca todo" / "marcatodo" = "Marcadores PELIKAN 420 Pastel" (stock:60)
   - "repuesto canson N°5 blanco/color/negro x8 hojas" = "REPUESTO DE DIBUJO N 5 BLANCO/COLOR/NEGRO LUMA"
   - "fibras punta gruesa x12 (caja)" = buscar "fibra gruesa" o "trazo grueso" en catálogo
   - "cuaderno ABC Rivadavia 48 hojas espiralado" = "CUADERNOS ESP.ABC RIVADAVIA AULA UNIVERSAL x60 HOJAS" (el más cercano disponible)
   - "tempera en barra" / "tempera sólida" = "Marcador Tempera Solida Fluor Sifap x6"
   - "lapicera violeta" = cualquier lapicera de color disponible
   - "papel celofán" = "Acetato Transparente 50x70" (stock:9)
   - Productos de higiene (papel higiénico, jabón líquido, alcohol en gel, rollo de cocina): no están en catálogo, indicar al cliente que consulte disponibilidad con un asesor
   - Artículos de jardín/ciencias (flauta dulce, papel film, espuma de afeitar, rociador, esponja, limpiapipas, vasos/platos/tenedores descartables, gotero, jeringa, bicarbonato, fécula, cremor tártaro): NO están en catálogo — indicar que consulten con un asesor
   - Artículos de educación física (palo de hockey, bocha, protector bucal, canilleras): NO están en catálogo
   - "birome roja/negra/azul" = "Boligrafo BIC Cristal" (stock disponible)
   - "lapicera Frixión" / "lapicera tinta borrable" = "Boligrafo Borrable Gel BIC Gelocity Ilusion" (lo más cercano disponible)
   - "cartucho azul lavable" / "cartucho tinta azul" = "Cartucho Pelikan corto x6u Azul" (stock:19) o "Cartucho Repuesto Parker Pluma x5" (stock:34)
   - "folio N°3 plástico" = "Folios A4 LUMA" (stock:206) — aunque es A4, es el folio disponible
   - "block El Nene negro" = no existe en catálogo — ofrecer "Cartulina Lisa Varios Colores" como alternativa oscura
   - "block El Nene Éxito N°5 color" = no existe en catálogo — ofrecer REPUESTO DE DIBUJO N5 COLOR LUMA o similar
   - "mapa de Salta político/físico", "mapa de Europa", "mapa de América del Sur" = no existen mapas específicos por región — ofrecer MAPAS Politico N°3 o N°5 e indicar al cliente que verifique disponibilidad de región específica con un asesor
   - "papel araña color" = "Papel Araña Color 50X70CM" — verificar si existe en catálogo como "papel araña"
   - "repuesto de hojas rayadas 488 hojas" = REPUESTO RIVADAVIA N3 u otro repuesto disponible
   - "fibra trazo grueso" / "fibras punta gruesa" = buscar marcadores con "trazo grueso" o "punta gruesa" en catálogo
   - "cinta razo/raso bebé" = cinta genérica disponible
   - "cartulinas entretenidas" = "Block Cartulina Entretenida MURESCO"
   - "sacapuntas" = "Sacapuntas Para Zurdos Igloo Maped" — es el único con stock, usalo aunque diga "zurdos"
   - "cartulina lisa" = "Cartulina Lisa Varios Colores" 
   - "barritas de silicona gruesa" = "Barra Adhesiva de Silicona P/Pistola"
   - "globos de colores" = "GLOBOS TUKY" (NO globo terráqueo)
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
      
      // Si el texto extraído es muy corto, tiene muchos caracteres raros, o parece
      // tabla rota (muchos números seguidos de espacios), tratar como imagen con visión
            const isGarbled = !rawText || rawText.trim().length < 10 ||
        (rawText.split("\n").filter(l => l.trim()).length < 3 && rawText.length > 50);

      if (isGarbled && file.mimetype === "application/pdf") {
        // Intentar con visión: convertir primera página a imagen
        try {
          parsedItems = await parseListFromPdfVision(file.path);
        } catch (visionErr) {
          return res.status(400).json({ error: "No se pudo leer el archivo. Intentá con una foto de la lista." });
        }
      } else if (!rawText || rawText.trim().length < 10) {
        return res.status(400).json({ error: "No se pudo leer texto del archivo." });
      } else {
        try {
          parsedItems = await parseListWithAI(rawText);
        } catch (aiErr) {
          // Si el parseo de texto falla (lista muy larga o compleja), intentar con visión PDF
          if (file.mimetype === "application/pdf") {
            parsedItems = await parseListFromPdfVision(file.path);
          } else {
            throw aiErr;
          }
        }
      }
    }

    const matchedItems = await matchWithCatalog(parsedItems);

    // Enriquecer con slug de URL — buscar por SKU (más confiable que por ID)
    const catalogBySku = Object.fromEntries(
      CATALOG.filter(p => p.sku).map(p => [String(p.sku).trim(), p])
    );
    const catalogByName = {};
    CATALOG.forEach(p => { catalogByName[p.name.toLowerCase().trim()] = p; });

    matchedItems.forEach(item => {
      if (!item.matched) return;
      let prod = null;

      // 1. Buscar por SKU
      if (item.catalogSku) {
        prod = catalogBySku[String(item.catalogSku).trim()];
      }
      // 2. Buscar por nombre exacto
      if (!prod && item.catalogName) {
        prod = catalogByName[item.catalogName.toLowerCase().trim()];
      }
      // 3. Buscar por ID como fallback
      if (!prod && item.catalogId) {
        prod = CATALOG.find(p => p.id === item.catalogId);
      }

      if (prod) item.catalogSlug = prod.slug || null;
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
