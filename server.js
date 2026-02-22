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
  // ── Papel / hojas sueltas ────────────────────────────────────────
  "hojas a4": ["resma", "hojas"],
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
  "papel calcar": ["calcar", "vegetal", "manteca"],
  "papel celofan": ["celofan", "acetato"],
  "papel acetato": ["acetato"],
  "tapa acetato": ["acetato", "tapa"],

  // ── Papel afiche / madera / cometa / crepe ───────────────────────
  "papel afiche": ["papel afiche", "afiche", "block afiche", "block de dibujo n° 5 afiche"],
  "afiche": ["afiche", "papel afiche"],
  "afiches": ["afiche", "papel afiche"],
  "block afiche": ["block afiche", "afiche"],
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
  "papel glase": ["glace"],
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
  "cartulina color": ["cartulina lisa", "cartulina"],
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
  "fibra pizarra": ["marcador pizarra"],
  "fibron pizarra": ["marcador pizarra"],
  "fibrón pizarra": ["marcador pizarra"],
  "marcador pizarra": ["marcador pizarra"],
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
  "cinta papel": ["cinta de papel"],
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
  "plasticina": ["plastilina"],

  // ── Tizas ────────────────────────────────────────────────────────
  "tiza": ["tiza"],
  "tizas": ["tiza"],
  "tizas blancas": ["tiza"],
  "tizas de color": ["tiza color", "tiza"],
  "tizas color": ["tiza color", "tiza"],

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
  "cuaderno abc": ["cuaderno abc", "cuaderno rivadavia"],
  "cuaderno anillado": ["cuaderno espiral", "cuaderno espiralado"],
  "cuaderno espiralado": ["cuaderno espiral", "cuaderno espiralado"],
  "cuaderno tapa dura": ["cuaderno tapa dura", "cuaderno td"],
  "cuaderno caligrafia": ["caligrafia"],
  "cuaderno 24 hojas": ["cuaderno 24"],
  "cuaderno 48 hojas": ["cuaderno 48"],
  "cuaderno 100 hojas": ["cuaderno 100", "cuaderno espiralado"],
  "cuaderno comunicaciones": ["cuaderno comunicaciones", "cuaderno comunicacion"],
  "libreta comunicacion": ["cuaderno comunicaciones"],

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
  "mapas": ["mapa"],
  "planisferio": ["planisferio"],
  "diccionario": ["diccionario"],
  "calculadora": ["calculadora"],
  "agenda": ["agenda"],

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
   - "papel afiche" = "Papel afiche vs colores" o similar (NO un block de dibujo)
   - "block hojas canson N°3" / "block N3" = "Repuesto" de hojas para carpeta N3 (ej: REPUESTO RIVADAVIA N3, REPUESTO TRIUNFANTE N3)
   - "sacapuntas" = "Sacapuntas Para Zurdos Igloo Maped" (el único con stock)
   - "tinta" en contexto escolar = "Borratinta Pelikan" o lapicera con tinta
   - "diccionario" = cualquier diccionario del catálogo (español, inglés, sinónimos)
   - "pendrive" = "Pendrive KINGSTON" u otro pendrive disponible
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
      if (!rawText || rawText.trim().length < 10) {
        return res.status(400).json({ error: "No se pudo leer texto del archivo." });
      }
      parsedItems = await parseListWithAI(rawText);
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
