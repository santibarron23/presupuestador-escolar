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



// ─── JSON PARSER SEGURO ───────────────────────────────────────────────
function safeJsonParse(text) {
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    const match = clean.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    return JSON.parse(clean);
  } catch (e) {
    throw new Error("No se pudo parsear la respuesta de la IA");
  }
}

// ─── PRE-FILTRO DE CATÁLOGO ───────────────────────────────────────────
function normalize(str) {
  return str.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ").trim();
}

// Mapa de sinónimos: palabra buscada → palabras a buscar en catálogo
const KEYWORD_EXPANSIONS = {
  // Escritura
  "borrador":    ["borrar", "banderas", "classic", "goma"],
  "goma":        ["borrar", "banderas", "classic"],
  "lapiz":       ["lapiz", "negro"],
  "lapices":     ["lapiz", "color"],
  "folio":       ["folio", "folios", "luma", "plastico"],
  "folios":      ["folio", "folios", "luma", "plastico"],
  "regla":       ["regla", "escolar", "maped", "pelikan"],
  "birome":      ["boligrafo", "bic", "cristal"],
  "boligrafo":   ["boligrafo", "bic"],
  "fibron":      ["fibra", "marcador"],
  "fibra":       ["fibra", "color"],
  "plasticola":  ["adhesivo", "plasticola", "cola"],
  "voligoma":    ["voligoma"],
  "boligoma":    ["voligoma"],
  "silicona":    ["silicona", "barra"],
  "tijera":      ["tijera"],
  "sacapuntas":  ["sacapunta", "maped", "metal", "satelite", "filgo"],
  "sacapunta":   ["sacapunta", "maped", "metal", "satelite", "filgo"],
  "cartuchera":  ["cartuchera"],
  // Papeles
  "glase":       ["glace", "lustre", "luma"],
  "glasé":       ["glace", "lustre", "luma"],
  "glace":       ["glace", "lustre", "luma"],
  "crepe":       ["crepe", "papel"],
  "contac":      ["contact", "contac"],
  "contact":     ["contact"],
  "madera":      ["madera"],
  "afiche":      ["afiche"],
  "cartulina":   ["cartulina"],
  "celofan":     ["acetato", "celofan"],
  // Carpetas y cuadernos
  "carpeta":     ["carpeta"],
  "cuaderno":    ["cuaderno"],
  "block":       ["block"],
  "repuesto":    ["repuesto"],
  "solapas":     ["solapas"],
  "cristal":     ["cristal", "transparente"],
  // Colores y arte
  "tempera":     ["tempera"],
  "acuarela":    ["acuarela"],
  "pincel":      ["pincel", "koby"],
  "crayones":    ["crayones", "crayons"],
  "plastilina":  ["plastilina"],
  "goma eva":    ["goma eva"],
  "gomeva":      ["goma", "eva"],
  // Otros
  "compas":      ["compas"],
  "geometria":   ["geometria"],
  "mapa":        ["mapa", "mapas"],
  "planisferio": ["planisferio", "mapa"],
  "globo":       ["tuky", "globo"],
  "ojalillos":   ["ojalillos"],
  "multibase":   ["multibase"],
  "palitos":     ["palito", "madera"],
  "tizas":       ["tiza"],
  "tiza":        ["tiza"],
  "calcar":      ["calcar"],
  "diccionario": ["diccionario"],
  "pendrive":    ["pendrive"],
};

// ─── FUZZY SEARCH: distancia de Levenshtein ─────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({length: m+1}, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

// Devuelve true si la palabra es "cercana" a alguna keyword (tolerancia según largo)
function fuzzyMatchWord(word, keyword) {
  if (word === keyword) return true;
  if (word.includes(keyword) || keyword.includes(word)) return true;
  const maxDist = keyword.length <= 4 ? 1 : keyword.length <= 7 ? 2 : 3;
  return levenshtein(word, keyword) <= maxDist;
}

// Expande keywords con fuzzy matching sobre el diccionario de sinónimos
function fuzzyExpandKeywords(words) {
  const extra = new Set();
  for (const word of words) {
    for (const [key, vals] of Object.entries(KEYWORD_EXPANSIONS)) {
      if (fuzzyMatchWord(word, key)) {
        vals.forEach(v => extra.add(v));
        extra.add(key);
      }
    }
  }
  return [...extra];
}

function expandKeywords(items) {
  const rawWords = items.flatMap(i =>
    normalize(i.item || "").split(/\s+/).filter(w => w.length > 2)
  );
  const expanded = new Set(rawWords);
  for (const word of rawWords) {
    if (KEYWORD_EXPANSIONS[word]) {
      KEYWORD_EXPANSIONS[word].forEach(e => expanded.add(e));
    }
    // Partial match exacto
    for (const [key, vals] of Object.entries(KEYWORD_EXPANSIONS)) {
      if (key.startsWith(word) || word.startsWith(key)) {
        vals.forEach(e => expanded.add(e));
      }
    }
  }
  // Fuzzy match: expande aunque el usuario haya escrito mal la palabra
  const fuzzyExtras = fuzzyExpandKeywords(rawWords);
  fuzzyExtras.forEach(e => expanded.add(e));
  return [...expanded];
}

function preFilterCatalog(items) {
  const keywords = expandKeywords(items);

  const singleKw = keywords.filter(k => !k.includes(" "));
  const multiKw  = keywords.filter(k =>  k.includes(" "));

  const scored = CATALOG.map(p => {
    const nameNorm  = normalize(p.name);
    const nameWords = nameNorm.split(/\s+/);
    const primaryName  = nameNorm.split(/[+\/]/)[0].trim();
    const primaryWords = primaryName.split(/\s+/);

    const singleScore = singleKw.filter(k =>
      nameWords.some(w => w.includes(k) || k.includes(w))
    ).length;

    const multiScore = multiKw.filter(k => nameNorm.includes(k)).length * 3;

    const primaryBonus = singleKw.filter(k =>
      primaryWords.some(w => w.includes(k) || k.includes(w))
    ).length;

    const startsWithBonus = singleKw.some(k => nameNorm.startsWith(k)) ? 3 : 0;

    return { ...p, score: singleScore + multiScore + primaryBonus + startsWithBonus };
  });

  const filtered = scored
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score);

  if (filtered.length < 50) {
    const rest = scored.filter(p => p.score === 0).slice(0, 100 - filtered.length);
    return [...filtered, ...rest].slice(0, 300);
  }

  return filtered.slice(0, 300);
}

// ─── HELPERS COMUNES ─────────────────────────────────────────────────
function buildCatalogText(items) {
  const relevantCatalog = preFilterCatalog(items);
  return relevantCatalog.map(
    (p) => `ID:${p.id} | SKU:${p.sku || "-"} | "${p.name}" | $${p.price} | stock:${p.stock > 0 ? p.stock : "SIN_STOCK"}`
  ).join("\n");
}

function buildDummyItems(rawText) {
  // Para el pre-filtro necesitamos items con formato {item: string}
  // Extraemos palabras clave del texto crudo directamente
  const words = rawText.toLowerCase()
    .replace(/[^\w\sáéíóúüñ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3);
  return words.map(w => ({ item: w, quantity: 1 }));
}

// ─── LLAMADA ANTHROPIC GENÉRICA ───────────────────────────────────────
async function callAnthropic(messages, maxTokens = 4000, attempt = 1) {
  const MAX_ATTEMPTS = 4;
  const RETRY_DELAYS = [0, 3000, 8000, 15000];
  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      { model: "claude-sonnet-4-20250514", max_tokens: maxTokens, messages },
      { headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
      }}
    );
    return response.data.content[0].text.trim();
  } catch (err) {
    const status = err && err.response && err.response.status;
    const isOverloaded = status === 529 || status === 503 || status === 502;
    const isRateLimit  = status === 429;
    if ((isOverloaded || isRateLimit) && attempt < MAX_ATTEMPTS) {
      const delay = isRateLimit
        ? (parseInt((err.response.headers && err.response.headers["retry-after"]) || "20") * 1000)
        : RETRY_DELAYS[attempt];
      console.log("API " + status + " — reintento " + attempt + "/" + (MAX_ATTEMPTS-1) + " en " + (delay/1000) + "s");
      await new Promise(r => setTimeout(r, delay));
      return callAnthropic(messages, maxTokens, attempt + 1);
    }
    throw err;
  }
}

// ─── BLOQUE DE REGLAS ABSOLUTAS ──────────────────────────────────────
// Se inyecta al INICIO de cada MATCHING_RULES_BLOCK en las 3 funciones.
// Tiene prioridad máxima sobre cualquier otra regla del prompt.
const ABSOLUTE_RULES_BLOCK = `
====================================================================
⛔ REGLAS ABSOLUTAS — LEER ANTES DE TODO. NUNCA IGNORAR. ⛔
====================================================================

Estas reglas tienen PRIORIDAD MÁXIMA sobre cualquier otra instrucción.
Si la lista pide alguno de estos productos, SIEMPRE usá el indicado.
NUNCA los marques como matched:false. SIEMPRE tienen stock disponible.

1. "birome" / "birome roja" / "birome azul" / "birome negra" / "lapicera" / "boligrafo"
   → SIEMPRE: catalogName="Boligrafo Bic 0,7 Punta Fina Cristal" | matched:true
   → JAMÁS devolver otro bolígrafo ni marcar como sin stock.

2. "voligoma" / "boligoma" / "plasticola o boligoma" / "plasticola o voligoma"
   → SIEMPRE: catalogName="Adhesivo VOLIGOMA" | matched:true | stock:43
   → JAMÁS devolver otra plasticola ni marcar como sin stock.

3. "folio" / "folios" / "10 folios" / "folios (3 anillos)" / "folios para carpeta" / "folio A4" / "folio N°3"
   → SIEMPRE: catalogName="Folios A4 LUMA" | matched:true | stock:206
   → Son hojas PLÁSTICAS para carpeta. JAMÁS devolver resmas de papel.

4. "hojas A4" / "hojas de máquina" / "40 hojas A4" / "50 hojas A4" / "hojas A4 blancas" / "resma" / "papel A4"
   → SIEMPRE buscar resma A4 o "Hoja A4 Blanca" en catálogo | matched:true
   → JAMÁS marcar como sin stock si existe alguna resma A4 en catálogo.

5. "sacapuntas" / "sacapunta"
   → SIEMPRE: catalogName="SACAPUNTA MAPED METAL SATELITE GRIS" o "SACAPUNTA FILGO METAL" | matched:true
   → HAY STOCK. JAMÁS marcar como sin stock.

6. "cuaderno de comunicados" / "cuaderno comunicados" / "cuaderno de comunicaciones"
   → SIEMPRE: catalogName="CUADERNO DE COMUNICACIONES LAPRIDA" | matched:true | stock:10
   → JAMÁS marcar como sin stock.

7. "borrador" / "goma de borrar"
   → SIEMPRE: catalogName="Goma de Borrar 2 BANDERAS Classic" | matched:true | stock:497

8. "lápiz" / "lapiz" / "lápiz negro" / "lápiz HB"
   → SIEMPRE: catalogName="Lapiz Negro Bic Evolution Hb" | matched:true | stock:48
   → JAMÁS devolver bolígrafo, birome ni lapicera cuando piden lápiz.

9. "plasticola" / "plasticola escolar" (sin mencionar voligoma/boligoma)
   → SIEMPRE: catalogName="Adhesivo Escolar STA" | matched:true | stock:36

10. "tizas" / "caja de tizas" / "1 caja de tizas"
    → SIEMPRE: catalogName="Tiza Color PLAYCOLOR X12" | matched:true | stock:9

11. "hojas rayadas" / "hojas de carpeta" / "hojas de cuaderno"
    → Buscar repuesto de hojas en catálogo | matched:true. JAMÁS sin stock si hay repuestos.

12. TAMAÑO DE HOJA — NUNCA mezclar A4 con Oficio:
    → Si piden "A4" o "carta": JAMÁS recomendar producto "oficio" ni "legal"
    → Si piden "oficio" o "legal": JAMÁS recomendar producto "A4" o "carta"
    → Esta regla aplica a resmas, blocks, repuestos, carpetas y cualquier papel.

13. TIPO DE HOJA — NUNCA mezclar rayado, cuadriculado ni liso:
    → Si piden "cuadriculado": JAMÁS recomendar rayado ni liso
    → Si piden "rayado" o "rayadas": JAMÁS recomendar cuadriculado ni liso
    → Si piden "liso" o "lisa": JAMÁS recomendar cuadriculado ni rayado
    → Esta regla aplica a cuadernos, blocks, repuestos y cualquier hoja.

====================================================================
FIN DE REGLAS ABSOLUTAS
====================================================================
`;

// ─── PARSEAR + MATCHEAR TEXTO EN 1 SOLA LLAMADA ──────────────────────
async function parseAndMatchFromText(rawText) {
  const dummyItems = buildDummyItems(rawText);
  const catalogText = buildCatalogText(dummyItems);

  const MATCHING_RULES_BLOCK = ABSOLUTE_RULES_BLOCK + `Para cada ítem de la lista, encontrá el producto más parecido del catálogo. Reglas:

1. PRIORIDAD DE STOCK: Siempre preferí productos con stock disponible. Si hay varias opciones similares, elegí la que tenga stock > 0. Solo matcheá un producto con SIN_STOCK si no existe ninguna otra opción con stock.

REGLAS CRÍTICAS DE TIPO DE PRODUCTO (nunca las ignores):
   - "folio" / "folios" / "10 folios" / "10 folios (3 anillos)" / "folios para carpeta" → SIEMPRE "Folios A4 LUMA" (stock:206) — HAY STOCK (206 unidades), son paquetes de 10. NUNCA resmas, NUNCA carpetas, NUNCA biblioratos.
   - "fibron" / "fibrón" / "fibrones" → SIEMPRE matchear con fibras/marcadores de color (ej: "FIBRA COLOR X10 TRABI MEGA"). NUNCA recomendar marcadores para pizarra (Edding, Trabi pizarra, etc.) salvo que explícitamente diga "para pizarra".
   - "tijera" / "tijeras" → NUNCA recomendar tijera para zurdos salvo que el ítem diga explícitamente "zurdo" o "zurdos".
   - "voligoma" → SIEMPRE matchear con "Adhesivo VOLIGOMA" (stock:43). No buscar alternativas.
   - "lapiz" / "lápiz" / "lápices" → NUNCA recomendar bolígrafo, birome ni lapicera. Siempre recomendar un lápiz (negro o de colores según contexto).
   - "resma" / "resmas" → SIEMPRE se refiere a hojas A4 blancas. Matchear con "RESMA A4 X100 HOJAS LUMA COLOR" u otras resmas A4. Igualmente, "hojas A4" o "hojas de máquina" → resma A4.
   - "afiche color" / "papel afiche" / "papel de color claro" → SIEMPRE matchear con "Papel afiche vs colores" (hoja suelta). NUNCA recomendar un block de dibujo para esta búsqueda.
   - "pote de acrílico" / "pintura acrílica" / "acrílico para pintar" → SIEMPRE matchear con pinturas acrílicas en pote como "Base Acrilica Eterna 200 cc" (stock:2), "Set Acrilico Valija ETERNA" (stock:1). NUNCA recomendar marcadores acrílicos ni marcadores en general.
   - "block de afiches" → "Block De Dibujo N° 5 Afiche El Nene" (stock:10). Distinto de "papel afiche" suelto.
   - "goma eva lisa" → "Goma Eva Lisa" (stock:48). NUNCA confundir con juegos de encastre.
   - "goma eva con brillo" / "goma eva glitter" → "Goma Eva C/Glitter" (stock:49).

2. Buscá por CONCEPTO, no por nombre exacto. Reglas críticas de matcheo:

   ⚠️ REGLAS DE EXCLUSIÓN OBLIGATORIAS (nunca ignorar):
   - Si pide "folio" o "folios": SIEMPRE matchear con "Folios A4 LUMA" (stock:206) o "Folios Oficio LUMA" (stock:46). NUNCA con carpetas, biblioratos ni otro producto.
   - Si pide "fibron" / "fibrón" / "marcador grueso": matchear con FIBRAS de color (ej: FIBRA COLOR X10 TRABI MEGA). NUNCA con marcadores para pizarra salvo que diga explícitamente "para pizarra".
   - Si pide "tijera" / "tijeras": matchear con tijeras normales (TIJERA SABONIS, TIJERA PIZZINI, TIJERA SIMBALL). NUNCA elegir tijera para zurdos salvo que la lista diga "para zurdo" o "zurdo".
   - Si pide "voligoma" / "boligoma": matchear SIEMPRE con "Adhesivo VOLIGOMA" (stock:43).
   - ⛔ REGLA ABSOLUTA: Si pide "lápiz" / "lapiz" en CUALQUIER forma: JAMÁS devolver bolígrafo, lapicera, birome ni portaminas. Solo lápices de grafito o de colores.
   - ⛔ REGLA ABSOLUTA: Si pide "borrador" / "goma de borrar": SIEMPRE y ÚNICAMENTE "Goma de Borrar 2 BANDERAS Classic" (stock:497). Sin excepciones.
   - ⛔ REGLA ABSOLUTA: Si pide "folio" / "folios": JAMÁS devolver resmas de papel. Folios son hojas plásticas para carpeta. SIEMPRE "Folios A4 LUMA" (stock:206).
   - ⛔ REGLA ABSOLUTA: Si pide "cuaderno A4 tapa dura rayado": SIEMPRE "CUADERNO ESP. ABC RIVADAVIA x100 HOJAS". NUNCA cuadernos Oxford.
   - Si pide "lápiz" / "lapiz": NUNCA matchear con bolígrafo, lapicera ni birome. Siempre un lápiz.
   - Si pide "resma" / "resmas" sin especificar: SIEMPRE matchear con resma A4 (ej: "RESMA A4 X100 HOJAS LUMA COLOR"). Viceversa: "hojas A4" o "papel A4" = resma A4.
   - Si pide "afiche de color claro" / "papel afiche" / "afiche color": NUNCA recomendar un block. Buscar "Papel afiche vs colores" (aunque tenga stock 0, es el producto correcto — indicar al cliente que consulte disponibilidad). Si hay stock de ese producto, mostrarlo.
   - Si pide "pote de acrílico" / "pintura acrílica" / "acrílico" para arte: recomendar "Base Acrilica Eterna 200 cc" (stock:2) o "Set Acrilico Valija ETERNA". NUNCA recomendar marcadores acrílicos ni impermeabilizante.

   Equivalencias completas (producto solicitado → producto en catálogo):

   ESCRITURA Y GRAFITO:
   - "lápiz" / "lapiz negro" / "lápiz de grafito" / "lápices de grafito" / "lapiz HB" / "lapiz escolar" = SIEMPRE "Lapiz Negro Bic Evolution Hb" (stock:48) como primera y preferida opción. JAMÁS recomendar un bolígrafo, lapicera o birome cuando piden un lápiz. Son productos completamente distintos.
   - "borrador" / "goma de borrar" / "goma borrar" / "goma" (en contexto escolar) = SIEMPRE y ÚNICAMENTE "Goma de Borrar 2 BANDERAS Classic" (stock:497). NUNCA otra marca, NUNCA otro modelo. Esta es la única opción correcta.
   - "birome roja" / "birome" / "lapicera" / "boligrafo" = SIEMPRE "Boligrafo Bic 0,7 Punta Fina Cristal" (stock:69) como primera y única opción por defecto. Sin excepciones.
   - "lapicera Frixión" / "lapicera tinta borrable" = "Boligrafo Borrable Gel BIC Gelocity Ilusion"
   - "cartucho azul lavable" / "cartucho tinta azul" = "Cartucho Pelikan corto x6u Azul" (stock:19) o "Cartucho Repuesto Parker Pluma x5" (stock:34)
   - "tinta" en contexto escolar = "Borratinta Pelikan" o lapicera con tinta
   - "portaminas" = cualquier portaminas del catálogo

   ADHESIVOS:
   - "voligoma" / "boligoma" / "voligomas grandes" / "adhesivo voligoma" / "plasticola o boligoma" / "plasticola o voligoma" = SIEMPRE y ÚNICAMENTE "Adhesivo VOLIGOMA" (stock:36). NUNCA otro adhesivo cuando la lista diga "voligoma" o "boligoma". Dentro del artículo se elige el tamaño.
   - "plasticola" / "plasticola escolar" = "Adhesivo Escolar STA" (stock:36) o "Adhesivo Plasticola Color 40 Cc" (stock:8)
   - "plasticola con glitter" / "adhesivo con glitter" / "cola glitter" = "Adhesivo con Glitter PELIKAN" (stock:5)
   - "barritas de silicona gruesa" / "barras de silicona" = "Barra Adhesiva de Silicona P/Pistola" (stock:474) — dentro del artículo se elige el espesor
   - "silicona liquida" = "Silicona Liquida STA" (stock:21) o "Silicona Liquida PELIKAN" (stock:2)
   - "cinta de papel" / "cinta de papel gruesa" / "cinta papel" = "Cinta de Papel Auca" (stock:29) — dentro del artículo se elige la medida. "gruesa" es el grosor, no un producto diferente
   - "cinta de embalar" / "cinta scotch" / "cinta adhesiva transparente" = "Cintas Adhesivas AUCA 48x50" (stock:16) — dentro del artículo se elige el color
   - "ojalillos" / "plancha de ojalillos" = "Ojalillos Escolares X 30 Unidades" (stock:4) o "Ojalillos Escolares X Unidad" (stock:32)

   PAPELES Y BLOCKS:
   - "papel glasé metalizado" / "PAQ papel glase metalizado" = "Papel Glace Metalizado Surtido Luma" (stock:90)
   - "papel glasé flúo" / "PAQ papel glase fluo" = "Papel Glace Fluo Surtido Luma" (stock:95)
   - "papel glasé opaco" / "PAQ papel glase opaco" / "papel glasé lustre" / "papel glasé mate" = "Papel Glace Lustre Surtido Luma" (stock:80)
   - "papel glace (1 fluo, 1 mate, 1 metalizado)" / "3 papel glace" / "sobres de papel glasé" = son 3 productos DISTINTOS: "Papel Glace Fluo Surtido Luma" (stock:95) + "Papel Glace Lustre Surtido Luma" (stock:80) + "Papel Glace Metalizado Surtido Luma" (stock:90). Cuando la lista pide varios tipos en la misma línea, separarlos en 3 items encontrados distintos, quantity 1 cada uno.
   - NOTA: "glase" y "glace" son la misma cosa — diferencia ortográfica del mismo producto
   - "papel cometa" / "papel seda" = "Papel Seda / Cometa Varios Colores" (stock:45) o "Papel Seda / Cometa Fantasia Varios Colores" (stock:63) — dentro del artículo se elige el color
   - "papel afiche" / "afiche de color" / "papel afiche o papel madera" = primero verificar "Papel afiche vs colores". Si no tiene stock, ofrecer "Papel Madera 80x100" (stock:60) como alternativa
   - "hojas acartonadas color" / "cartón corrugado color" = "Carton corrugado vs.colores" (stock:7) — tamaño afiche, dentro del artículo se elige el color
   - "papel calcar" / "sobre de papel calcar" / "repuesto de calcar" = "Repuesto de Calcar N 5 Iglu" (stock:9) o "Repuesto de Calcar N 3 Luma" (stock:9)
   - "papel madera" / "hojas de papel madera" / "papel afiche o papel madera" / "papel afiche" = "Papel Madera 80x100" (stock:60) — cuando la lista pide "papel afiche O papel madera", matchear con Papel Madera 80x100 ya que es el disponible
   - "block de papel madera" / "block papel madera" = "Block Papel Madera MURESCO" (stock:3)
   - "hojas A4 blancas" / "hojas de máquina A4" = "Hoja A4 Blanca x50 U."
   - "hojas A4 de colores" = "RESMA A4 LUMA COLOR" o similar
   - "papel celofán" = "Acetato Transparente 50x70" (stock:9)

   BLOCKS DE DIBUJO Y CARTULINA:
   - "block de afiches" / "block afiches" = "Block De Dibujo N° 5 Afiche El Nene" (stock:10)
   - "block de cartulinas" / "block cartulinas" / "block cartulinas fantasia" / "block cartulinas entretenidas" / "block cartulinas x24 hojas" = "Block Cartulina Fantasia N° 5 El Nene" (stock:14) o "Block El Nene N° 5 Aguayos" (stock:8) o "Block El Nene N° 5 Patrios" (stock:10). IGNORAR el número de hojas (x24, x12, etc.) al matchear — son detalles internos del producto
   - "cartulina" / "cartulina lisa" / "cartulina color" / "1 cartulina" = "Cartulina Lisa Varios Colores" (stock:69) o "Cartulina Metalizada Varios Colores" (stock:29) según contexto
   - "cartulina metalizada" = "Cartulina Metalizada Varios Colores" (stock:29)
   - "repuesto canson N°5" / "hojas de dibujo N°5" = "REPUESTO DE DIBUJO N 5 BLANCO/COLOR/NEGRO LUMA"
   - "hojas de colores y blancas (canson)" / "hojas canson color y blancas" = son DOS productos distintos que deben aparecer por separado:
     * Hojas de colores: "Repuesto De Dibujo N° 3 Color Exito" (stock:2) o "REPUESTO DE DIBUJO N 5 COLOR LUMA" (stock:6)
     * Hojas blancas: "Repuesto De Dibujo N° 3 Blanco Exito" (stock:10) o "REPUESTO DE DIBUJO N° 3 BLANCO LUMA" (stock:9)
   - "hojas canson de color" / "hojas de colores N°3" / "block canson color" = "Repuesto De Dibujo N° 3 Color Exito" (stock:2) o "REPUESTO DE DIBUJO N 5 COLOR LUMA" (stock:6)
   - "hojas canson blancas" / "hojas blancas N°3" / "block canson blanco" = "Repuesto De Dibujo N° 3 Blanco Exito" (stock:10) o "REPUESTO DE DIBUJO N° 3 BLANCO LUMA" (stock:9)
   - "block canson N°3" / "hojas color N°3" = "Repuesto De Dibujo N° 3 Color Exito" (stock:2) o "REPUESTO RIVADAVIA N3"

   GOMA EVA:
   - "goma eva lisa" = "Goma Eva Lisa" (stock:48) — dentro del artículo se elige el color
   - "goma eva con brillo" / "goma eva brillante" / "goma eva glitter" / "1 goma eva con brillo" = "Goma Eva C/Glitter" (stock:49) — dentro del artículo se elige el color. SIEMPRE matchear con este producto cuando dice "con brillo" o "glitter"

   MARCADORES Y FIBRAS:
   - "fibron para pizarra" / "fibron pizarra" / "marcador para pizarra" / "marcador pizarra" / "fibron pizarrón" = SIEMPRE "MARCADOR PARA PIZARRA TRABI 450" (stock:9) como primera y preferida opción — dentro del artículo se elige el color
   - "fibron" / "felpon" / "fibra trazo grueso" = fibra de color, buscar FIBRA en catálogo
   - "fibron negro permanente" / "marcador negro permanente" / "fibron permanente punta redonda" / "fibrones negros permanente" = "Marcador Edding 400 Permanente" (stock:20) o "Marcadores FILGO x6 Permanentes" (stock:3) o "Fibra Permanente BIC Intensity" (stock:2+). SIEMPRE hay stock de marcadores permanentes
   - "marca todo" / "marcatodo" = "Marcadores PELIKAN 420 Pastel" (stock:60)
   - "resaltador" = cualquier resaltador del catálogo con stock

   GEOMETRÍA Y REGLAS:
   - "regla" / "regla escolar" = "Regla escolar de 20Cm. Acrilica marca Maped" (stock:15) o "Regla escolar de 30Cm. marca Pelikan" (stock:9)
   - "regla flexible" / "regla blanda" = "Regla escolar de 30Cm. marca Pelikan" (stock:9) — es la más flexible del catálogo
   - "regla dura 20cm" / "regla 20cm" = "Regla escolar de 20Cm. Acrilica marca Maped" (stock:15)
   - "set de geometría" / "juego de geometría" / "elementos de geometría" = "Juego De Geometria Maped 30Cm - 4 Unidades" (stock:5) o "Juego De Geometria Maped 20Cm - 3 Unidades" (stock:6) — incluye regla, escuadra, transportador y compas
   - "compas" / "compás escolar" = "Compas Pizzini Pk630 Tecnico" (stock:5)
   - "escuadra" / "transportador" = buscar en catálogo dentro de juego de geometría

   PINCELES:
   - "pincel número 4" / "pincel N°4" / "pincel escolar" = "PINCEL KOBY REDONDO" (stock:5) — dentro del artículo se elige el número
   - "set de pinceles" = "Set De Pinceles Chatos X 8 Sabonis" (stock:6)

   CARPETAS:
   - "carpeta de 3 anillos" / "carpeta 3 anillos" / "carpeta N°3 tres ganchos" = buscar carpeta escolar de 3 anillos. JAMÁS recomendar carpetas que incluyan folios adentro. Opciones: "CARPETA ESCOLAR PLANETA AZUL LOBO" (stock:10+) u otras carpetas escolares con 3 anillos
   - "carpeta oficio 3 solapas con elástico" / "carpeta 3 solapas" / "carpeta 3 solapas elástico" = "Carpeta 3 Solapas Carton Color" (stock:10) o "Carpeta 3 Solapas Kraft" (stock:7) — dentro del artículo se elige tamaño (A4 u oficio). SIEMPRE matchear, hay stock
   - "carpeta en L transparente" / "tapa cristal" / "carpeta plástica transparente" / "carpeta transparente con nepaco" / "carpeta cristal" = "Carpeta Tapa Cristal A4" (stock:27) — SIEMPRE matchear, hay stock
   - "folio" / "folios" / "folio A4" / "folio N°3" / "folios plásticos" (sin especificar detalle) = SIEMPRE "Folios A4 LUMA" (stock:206). JAMÁS recomendar una resma de hojas cuando piden folios — son productos completamente distintos. Folios = hojas plásticas transparentes para carpeta.

   GLOBOS Y OTROS MATERIALES:
   - "globos de colores" / "bolsa de globos" = "GLOBOS TUKY 9\" X25U." (stock disponible) — NUNCA globo terráqueo
   - "palitos de madera" / "palitos de helado" / "palito helado color" = "Mini Palitos de Madera ONIX" (stock:55) o "Mini Palitos de Madera tipo Paleta ONIX x50" (stock:57)
   - "plastilinas" / "plastilina" / "10 plastilinas" / "x plastilinas" = "Plastilinas PELIKAN Pastel" (stock:10) o "Plastilina escolar PlayColor x10" (stock:5). NUNCA "Plastilina Escolar KEYROAD" (stock:0). La cantidad pedida (10, 6, etc.) NO es el stock — el stock es lo que hay en depósito
   - "tizas" / "caja de tizas" / "1 caja de tizas" = "Tiza Color PLAYCOLOR X12" (stock:9) o "Tiza Blanca x 12 Playcolor" (stock:9). SIEMPRE matchear — hay stock
   - "crayones" = cualquier caja de crayones del catálogo con stock
   - "tempera" = cualquier tempera disponible
   - "acuarela" = cualquier acuarela del catálogo

   CUADERNOS:
   - "cuaderno A4 rayado tapa dura" / "cuaderno ABC" / "cuaderno espiral ABC" / "cuaderno A4 tapa dura rayado" = SIEMPRE "CUADERNO ESP. ABC RIVADAVIA x100 HOJAS" (stock:5) como primera opción. NUNCA recomendar cuadernos Oxford (son demasiado caros). Alternativa: "CUADERNOS ESP.ABC RIVADAVIA AULA UNIVERSAL x60 HOJAS"
   - "cuaderno de comunicaciones" / "cuaderno comunicados" / "cuaderno de comunicados" / "cuaderno de comunicaciones" = SIEMPRE "CUADERNO DE COMUNICACIONES LAPRIDA" (stock:10). "comunicados" y "comunicaciones" son la misma cosa.

   MAPAS:
   - "mapa Argentina" / "mapa división política" / "mapa político" = "MAPAS Politico N°3" (stock:67) o "MAPAS Fisico N°3" (stock:77)
   - "mapa planisferio" / "mapa continente americano" / "mapa Europa" = "MAPAS Politico N°3" o "MAPAS Fisico N°3" — indicar que el cliente verifique la región disponible con un asesor
   - "mapa mural planisferio" = "Mapa Mural Planisferio"

   MATERIALES DE ARTE Y PLÁSTICA:
   - "papel crepé" / "papel crepe" = "Papel Crepe Perlado surtidos" (stock:15) o "PAPEL CREPE SIFAP EN TIRAS COLORES CLASICO" (stock:3)
   - "papel crepé blanco" = "Papel Crepe Perlado surtidos" (stock:15) — elegir color blanco dentro del artículo
   - "papel crepé celeste" = "Papel Crepe Perlado surtidos" (stock:15) — elegir color celeste
   - "papel contact" / "plancha contact" / "plancha contac" / "contac transparente" = "Papel Contact Transparente X10M. ORITEC" (stock:10) o "Papel Contact Transparente X10M. Muresco" (stock:8)
   - "acuarela" / "acuarelas" = "ACUARELA x12 SIFAP POCKET" (stock:5) o "Acuarela Sifap x 12 Colores + Paleta + Pincel" (stock:30)
   - "pote de tempera" / "tempera en pote" / "tempera color" / "tempera celeste/naranja/etc" = "Tempera Alba Magic En Pote X 275G" (stock:9) o "Tempera FLUO Alba Magic En Pote X 275G" (stock:15) o "Tempera Surtida x 10 unidades Alba Magic" (stock:16)
   - "caja de fibras" / "fibras x12" / "caja de fibrones" = "FIBRA COLOR X12 EZCO (NEON + PASTEL)" (stock:5) o "FIBRA COLOR X12 CARIOCA PRISMA" (stock:3)
   - "caja lápices de colores x12" / "lapices de colores" = "LAPIZ COLOR X12 L.CARIOCA 4.0" (stock:4) o "LAPIZ COLOR x12 PELIKAN JUMBO" (stock:3)
   - "caja de crayones x12" / "paquete crayones" = "Crayones X12 Maped Largos Plasticlean" (stock:10) o "CRAYONES X12 CARIOCA ARTISTICOS" (stock:3)
   - "crayones cremosos" / "crayones gruesos" = "Crayones X12 Maped Largos Plasticlean" (stock:10) como opción más cercana
   - "multibase" / "multibase goma eva" / "equipo multibase" = "Multibase X 150 Piezas De Madera" (stock:5)
   - "pincel chato N°4" / "pincel chato escolar" = "PINCEL KOBY REDONDO" (stock:5) — elegir número dentro del artículo
   - "pincel punta chata N°18" / "pincel N°18" = "PINCEL KOBY REDONDO" (stock:5) — elegir número dentro del artículo
   - "pincel punta redonda" = "PINCEL KOBY REDONDO" (stock:5)
   - "fibron recargable negro" = "Marcador P/ Pizarra Recargable TRABI 450 PLUS X4 Surtidos" (stock:7)
   - "fibra jumbo" / "caja fibrones jumbo" = "FIBRA COLOR X10 KOBY JUMBO" (stock:5) o "FIBRA COLOR X10 FILGO JUMBO" (stock:5)

   NO DISPONIBLES (indicar "consultá con un asesor"):
   - Colorante vegetal en pasta: NO tenemos
   - Tapas plásticas tamaño oficio: NO tenemos
   - Tempera con brillo: NO tenemos stock
   - Block de hojas de papel madera: sin stock actualmente
   - Artículos de higiene (papel higiénico, jabón, alcohol en gel): NO están en catálogo
   - Artículos de jardín/ciencias (flauta, papel film, espuma de afeitar, rociador, esponja, limpiapipas, vasos descartables, gotero, jeringa, bicarbonato, fécula, cremor tártaro): NO están en catálogo
   - Artículos de educación física (palo de hockey, bocha, protector bucal, canilleras, equipo deportivo, remera colegio, zapatillas): NO están en catálogo
   - Libros escolares (libros de inglés, libros de matemática, Team Together, Biblias, libros de cuento para el jardín): NO están en catálogo — indicar que consulten con un asesor o librería especializada
   - Rodillo de pintura: NO está en catálogo
   - Papel araña: NO está en catálogo
   - Crayones cremosos específicos: no existe esa variante — ofrecer "Crayones X12 Maped" como alternativa
   - Juego didáctico / juego de memoria / rompecabezas: NO están en catálogo
   - Pulverizador / rociador: NO está en catálogo
   - Botones, telas, lanillas, broches de madera: NO están en catálogo
   - Tablet: NO está en catálogo
   - Taza, servilleta, cepillo de dientes: NO están en catálogo

   REGLA CRÍTICA DE STOCK: El campo "stock" del catálogo indica unidades del PAQUETE disponibles en depósito, NO la cantidad de items del producto. El stock NO necesita ser >= la quantity pedida para matchear.


3. Si el ítem tiene un prefijo como "PAQ", "CAJA DE", "SET DE", ignoralo y matcheá el producto principal.

4. La cantidad (quantity) ya viene definida — NO la cambies.

5. El subtotal = unitPrice × quantity.

6. Solo usá matched:false si genuinamente no existe ningún producto similar en el catálogo (ej: "colorante vegetal", "cortante de masa"). Si existe algo parecido con stock, siempre matcheá.

Devolvé SOLO un array JSON válido con este formato exacto, sin texto adicional:
[{"requestedItem":"nombre solicitado","quantity":1,"matched":true,"catalogId":1,"catalogName":"nombre producto","catalogSku":"SKU del producto","unitPrice":1000,"subtotal":1000,"confidence":"high"}]

Si no encontrás un producto similar, usá matched:false, catalogId:null, catalogName:null, catalogSku:null, unitPrice:0, subtotal:0.
Respondé ÚNICAMENTE con el JSON, empezando con [ y terminando con ].`;

  const prompt = `Tenés este catálogo de productos de una librería:
${catalogText}

Y este texto de una lista de útiles escolares:
---
${rawText}
---

PASO 1 - EXTRAER: Identificá cada producto de la lista aplicando estas reglas:
- La cantidad es el número ANTES del producto (ej: "2 blocks" → quantity:2)
- Si el número describe el contenido del paquete (ej: "50 hojas A4"), quantity:1 e incluilo en el nombre
- Separar productos en distintas líneas si vienen juntos con guión o coma
- Ignorar encabezados, grados, fechas, precios, artículos de higiene y educación física

PASO 2 - MATCHEAR: Para cada producto extraído, encontrá el más parecido del catálogo.
` + MATCHING_RULES_BLOCK;

  const text = await callAnthropic([{ role: "user", content: prompt }]);
  return safeJsonParse(text);
}

// ─── PARSEAR + MATCHEAR IMAGEN EN 1 SOLA LLAMADA ─────────────────────
async function parseAndMatchFromImage(filePath, mimeType) {
  const base64 = fs.readFileSync(filePath).toString("base64");

  // Para el pre-filtro de catálogo usamos todo el catálogo (sin items previos)
  // tomamos los 300 productos más comunes de útiles escolares
  const catalogText = CATALOG
    .filter(p => p.stock > 0)
    .slice(0, 300)
    .map(p => `ID:${p.id} | SKU:${p.sku || "-"} | "${p.name}" | $${p.price} | stock:${p.stock}`)
    .join("\n");

  const MATCHING_RULES_BLOCK = ABSOLUTE_RULES_BLOCK + `Para cada ítem de la lista, encontrá el producto más parecido del catálogo. Reglas:

1. PRIORIDAD DE STOCK: Siempre preferí productos con stock disponible. Si hay varias opciones similares, elegí la que tenga stock > 0. Solo matcheá un producto con SIN_STOCK si no existe ninguna otra opción con stock.

REGLAS CRÍTICAS DE TIPO DE PRODUCTO (nunca las ignores):
   - "folio" / "folios" / "10 folios" / "10 folios (3 anillos)" / "folios para carpeta" → SIEMPRE "Folios A4 LUMA" (stock:206) — HAY STOCK (206 unidades), son paquetes de 10. NUNCA resmas, NUNCA carpetas, NUNCA biblioratos.
   - "fibron" / "fibrón" / "fibrones" → SIEMPRE matchear con fibras/marcadores de color (ej: "FIBRA COLOR X10 TRABI MEGA"). NUNCA recomendar marcadores para pizarra (Edding, Trabi pizarra, etc.) salvo que explícitamente diga "para pizarra".
   - "tijera" / "tijeras" → NUNCA recomendar tijera para zurdos salvo que el ítem diga explícitamente "zurdo" o "zurdos".
   - "voligoma" → SIEMPRE matchear con "Adhesivo VOLIGOMA" (stock:43). No buscar alternativas.
   - "lapiz" / "lápiz" / "lápices" → NUNCA recomendar bolígrafo, birome ni lapicera. Siempre recomendar un lápiz (negro o de colores según contexto).
   - "resma" / "resmas" → SIEMPRE se refiere a hojas A4 blancas. Matchear con "RESMA A4 X100 HOJAS LUMA COLOR" u otras resmas A4. Igualmente, "hojas A4" o "hojas de máquina" → resma A4.
   - "afiche color" / "papel afiche" / "papel de color claro" → SIEMPRE matchear con "Papel afiche vs colores" (hoja suelta). NUNCA recomendar un block de dibujo para esta búsqueda.
   - "pote de acrílico" / "pintura acrílica" / "acrílico para pintar" → SIEMPRE matchear con pinturas acrílicas en pote como "Base Acrilica Eterna 200 cc" (stock:2), "Set Acrilico Valija ETERNA" (stock:1). NUNCA recomendar marcadores acrílicos ni marcadores en general.
   - "block de afiches" → "Block De Dibujo N° 5 Afiche El Nene" (stock:10). Distinto de "papel afiche" suelto.
   - "goma eva lisa" → "Goma Eva Lisa" (stock:48). NUNCA confundir con juegos de encastre.
   - "goma eva con brillo" / "goma eva glitter" → "Goma Eva C/Glitter" (stock:49).

2. Buscá por CONCEPTO, no por nombre exacto. Reglas críticas de matcheo:

   ⚠️ REGLAS DE EXCLUSIÓN OBLIGATORIAS (nunca ignorar):
   - Si pide "folio" o "folios": SIEMPRE matchear con "Folios A4 LUMA" (stock:206) o "Folios Oficio LUMA" (stock:46). NUNCA con carpetas, biblioratos ni otro producto.
   - Si pide "fibron" / "fibrón" / "marcador grueso": matchear con FIBRAS de color (ej: FIBRA COLOR X10 TRABI MEGA). NUNCA con marcadores para pizarra (Edding, Trabi pizarra, etc.) salvo que diga explícitamente "para pizarra".
   - Si pide "tijera" / "tijeras": matchear con tijeras normales (TIJERA SABONIS, TIJERA PIZZINI, TIJERA SIMBALL). NUNCA elegir tijera para zurdos salvo que la lista diga "para zurdo" o "zurdo".
   - Si pide "voligoma" / "boligoma": matchear SIEMPRE con "Adhesivo VOLIGOMA" (stock:43).
   - ⛔ REGLA ABSOLUTA: Si pide "lápiz" / "lapiz" en CUALQUIER forma: JAMÁS devolver bolígrafo, lapicera, birome ni portaminas. Solo lápices de grafito o de colores.
   - ⛔ REGLA ABSOLUTA: Si pide "borrador" / "goma de borrar": SIEMPRE y ÚNICAMENTE "Goma de Borrar 2 BANDERAS Classic" (stock:497). Sin excepciones.
   - ⛔ REGLA ABSOLUTA: Si pide "folio" / "folios": JAMÁS devolver resmas de papel. Folios son hojas plásticas para carpeta. SIEMPRE "Folios A4 LUMA" (stock:206).
   - ⛔ REGLA ABSOLUTA: Si pide "cuaderno A4 tapa dura rayado": SIEMPRE "CUADERNO ESP. ABC RIVADAVIA x100 HOJAS". NUNCA cuadernos Oxford. No buscar otro adhesivo.
   - Si pide "lápiz" / "lapiz" (negro o de color): NUNCA matchear con bolígrafo, lapicera ni birome. Siempre un lápiz.
   - Si pide "resma" / "resmas" sin especificar: SIEMPRE matchear con resma A4 (ej: "RESMA A4 X100 HOJAS LUMA COLOR"). Viceversa: "hojas A4" o "papel A4" = resma A4.
   - Si pide "afiche de color claro" / "papel afiche" / "afiche color": NUNCA recomendar un block. Buscar "Papel afiche vs colores" (aunque tenga stock 0, es el producto correcto — indicar al cliente que consulte disponibilidad). Si hay stock de ese producto, mostrarlo.
   - Si pide "pote de acrílico" / "pintura acrílica" / "acrílico" para arte: recomendar "Base Acrilica Eterna 200 cc" (stock:2) o "Set Acrilico Valija ETERNA". NUNCA recomendar marcadores acrílicos ni impermeabilizante.

   Equivalencias válidas:
   - "tijerita" = "tijera" (cualquier tijera del catálogo)
   - "papel afiche" / "afiches" = "Block De Dibujo N° 5 Afiche El Nene" u otro afiche disponible (NO "Bandera de Argentina", NO "Encastre Mapa")
   - "mapa Argentina" / "mapa división política" = buscar "MAPAS POLITICO" o "Mapa Mural" — NUNCA "Bandera de Argentina"
   - "mapa planisferio" / "planisferio" = "Mapa Mural Planisferio" — NUNCA confundir con bandera
   - "mapa continente americano" = "Mapa Mural America" 
   - "cuaderno ABC" / "cuaderno espiral ABC 100 hojas" = "CUADERNO ESP. ABC RIVADAVIA x100 HOJAS" o "CUADERNOS ESP.ABC RIVADAVIA" — NO cuadernos Oxford ni Norpac
   - "cuaderno de comunicaciones" / "cuaderno comunicados" / "cuaderno de comunicados" / "cuaderno de comunicaciones" = SIEMPRE "CUADERNO DE COMUNICACIONES LAPRIDA" (stock:10). "comunicados" y "comunicaciones" son la misma cosa. — NO ignorar este producto
   - "fibron para pizarra" / "fibrón pizarra" = "Marcador Edding 160 P/Pizarra" o "Marcador P/ Pizarra Recargable TRABI"
   - "block canson N°3" / "hojas color N°3" = "Repuesto" de hojas para carpeta N3 (ej: REPUESTO RIVADAVIA N3, REPUESTO TRIUNFANTE N3)
   - "sacapuntas" = SIEMPRE "SACAPUNTA MAPED METAL SATELITE GRIS" (stock:5) o "SACAPUNTA MAPED METAL 2 BOCAS" (stock:4) — HAY STOCK, nunca marcar como sin stock. Alternativas: SACAPUNTA FILGO METAL (stock:18), SACAPUNTA MAPED VIVO MONSTER (stock:8)
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
   - Artículos de educación física (palo de hockey, bocha, protector bucal, canilleras, equipo deportivo, remera colegio, zapatillas): NO están en catálogo
   - Libros escolares (libros de inglés, libros de matemática, Team Together, Biblias, libros de cuento para el jardín): NO están en catálogo — indicar que consulten con un asesor o librería especializada
   - Rodillo de pintura: NO está en catálogo
   - Papel araña: NO está en catálogo
   - Crayones cremosos específicos: no existe esa variante — ofrecer "Crayones X12 Maped" como alternativa
   - Juego didáctico / juego de memoria / rompecabezas: NO están en catálogo
   - Pulverizador / rociador: NO está en catálogo
   - Botones, telas, lanillas, broches de madera: NO están en catálogo
   - Tablet: NO está en catálogo
   - Taza, servilleta, cepillo de dientes: NO están en catálogo
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
   - "cartulina lisa" = "Cartulina Lisa Varios Colores" 
   - "barritas de silicona gruesa" = "Barra Adhesiva de Silicona P/Pistola"
   - "globos de colores" = "GLOBOS TUKY" (stock:2+) — NUNCA "globo terraqueo"
   - "goma eva lisa" = "Goma Eva Lisa" (stock:48) — existe en catálogo
   - "goma eva con brillo" / "goma eva glitter" = "Goma Eva C/Glitter" (stock:49)
   - "papel glase metalizado" / "PAQ papel glase metalizado" / "papel glasé metalizado" = "Papel Glace Metalizado Surtido Luma" (stock:90)
   - "papel glase fluo" / "PAQ papel glase fluo" / "papel glasé flúor" = "Papel Glace Fluo Surtido Luma" (stock:95)
   - "papel glase opaco" / "PAQ de papel glase opaco" / "papel glasé mate" / "papel glasé lustre" = "Papel Glace Lustre Surtido Luma" (stock:80)
   - "sobres de papel glase" / "sobres papel glase" / "papel glase" / "papel glasé" / "papel glace" (sin especificar tipo) = SIEMPRE "Papel Glace Lustre Surtido Luma" (stock:78) por defecto. Si especifica tipo: fluo→Papel Glace Fluo (stock:95), metalizado→Papel Glace Metalizado (stock:90), lustre/mate/opaco→Papel Glace Lustre (stock:78). Si dice "1 metalizado, 1 lustre, 1 fluo" o "1 fluo, 1 mate, 1 metalizado" son SIEMPRE 3 productos distintos: matchear cada uno con su producto. "mate" = Lustre
   - "cinta de embalar" / "cinta embalar" / "cinta scotch" = "Cintas Adhesivas AUCA 48x50" (stock:16)
   - "plasticola con glitter" / "adhesivo con glitter" / "cola vinilica glitter" = "Adhesivo Plasticola Color 40 Cc" (stock:8) — es lo más cercano disponible
   - "block de afiches" / "block afiches" / "bloque afiches" = "Block De Dibujo N° 5 Afiche El Nene" (stock:10)
   - "block de cartulinas" / "block cartulinas" / "block de cartulinas entretenidas" = "Block De Dibujo N° 5 Color El Nene" (stock:8) o "Block Cartulina Fantasia N° 5 El Nene" (stock:14)
   - "block de hojas de papel madera" / "block papel madera" = "Block Papel Madera MURESCO" (stock:3) o "Papel Madera 80x100" (stock:60)
   - "pincel numero 4" / "pincel n4" / "pincel escolar" = "Set De Pinceles Chatos X 8 Sabonis" (stock:6) o "Set de Pinceles Escolares Olami" (stock:1) — mencionar que se vende en set
   - "fibron" / "felpon" = "fibra" / "marcador"  
   - "birome" = "boligrafo"
   - "plasticola" = cualquier adhesivo similar
   - "PAQ papel glase opaco" = "Papel Glace Lustre" (el más parecido disponible)
   - "voligoma" / "boligoma" = adhesivo cola vinílica
   - "lapiz negro" = cualquier lapiz negro del catálogo
   - "crayones" = cualquier caja de crayones
   - "tempera" = cualquier tempera disponible
   - "plastilinas" / "plastilina" = elegí SIEMPRE la que tenga stock > 0: "Plastilina X10 Alba" (stock:15), "Plastilina X6 Alba" (stock:18) o "Plastilinas PELIKAN Pastel" (stock:10). NUNCA elijas "Plastilina Escolar KEYROAD" que tiene stock:0
   - "tizas" / "caja de tizas" / "1 caja de tizas" = "Tiza Color PLAYCOLOR X12" (stock:9) o "Tiza Blanca x 12 Playcolor" (stock:9). SIEMPRE matchear — hay stock
   - "hojas A4 blancas" / "hojas de máquina A4" = "Hoja A4 Blanca x50 U."
   - "hojas A4 de colores" / "hojas de máquina A4 de colores" = "RESMA A4 210X219X100H.LUMA COLOR" o similar con stock
   - REGLA CRÍTICA: El stock del catálogo indica unidades del PAQUETE en depósito, NO la cantidad de items del producto. Si el cliente pide 10 plastilinas, elegí cualquier plastilina con stock > 0 sin importar si el stock es 5, 15 o 100. El stock NO necesita ser >= la quantity pedida.

3. Si el ítem tiene un prefijo como "PAQ", "CAJA DE", "SET DE", ignoralo y matcheá el producto principal.

4. La cantidad (quantity) ya viene definida — NO la cambies.

5. El subtotal = unitPrice × quantity.

6. Solo usá matched:false si genuinamente no existe ningún producto similar en el catálogo (ej: "colorante vegetal", "cortante de masa"). Si existe algo parecido con stock, siempre matcheá.

Devolvé SOLO un array JSON válido con este formato exacto, sin texto adicional:
[{"requestedItem":"nombre solicitado","quantity":1,"matched":true,"catalogId":1,"catalogName":"nombre producto","catalogSku":"SKU del producto","unitPrice":1000,"subtotal":1000,"confidence":"high"}]

Si no encontrás un producto similar, usá matched:false, catalogId:null, catalogName:null, catalogSku:null, unitPrice:0, subtotal:0.
Respondé ÚNICAMENTE con el JSON, empezando con [ y terminando con ].`;

  const prompt = `Esta imagen contiene una lista de útiles escolares.

Tenés este catálogo de productos de una librería:
${catalogText}

PASO 1 - EXTRAER: Leé todos los productos de la imagen (incluyendo texto manuscrito o impreso).
- La cantidad es el número ANTES del producto
- Si el número describe el contenido del paquete, quantity:1
- Separar productos distintos en ítems separados
- Ignorar encabezados, fechas, artículos de higiene y educación física

PASO 2 - MATCHEAR: Para cada producto extraído, encontrá el más parecido del catálogo.
` + MATCHING_RULES_BLOCK;

  const text = await callAnthropic([{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
      { type: "text", text: prompt }
    ]
  }]);
  return safeJsonParse(text);
}

// ─── PARSEAR + MATCHEAR PDF (VISIÓN) EN 1 SOLA LLAMADA ───────────────
async function parseAndMatchFromPdfVision(pdfPath) {
  const base64 = fs.readFileSync(pdfPath).toString("base64");

  const catalogText = CATALOG
    .filter(p => p.stock > 0)
    .slice(0, 300)
    .map(p => `ID:${p.id} | SKU:${p.sku || "-"} | "${p.name}" | $${p.price} | stock:${p.stock}`)
    .join("\n");

  const MATCHING_RULES_BLOCK = ABSOLUTE_RULES_BLOCK + `Para cada ítem de la lista, encontrá el producto más parecido del catálogo. Reglas:

1. PRIORIDAD DE STOCK: Siempre preferí productos con stock disponible. Si hay varias opciones similares, elegí la que tenga stock > 0. Solo matcheá un producto con SIN_STOCK si no existe ninguna otra opción con stock.

REGLAS CRÍTICAS DE TIPO DE PRODUCTO (nunca las ignores):
   - "folio" / "folios" / "10 folios" / "10 folios (3 anillos)" / "folios para carpeta" → SIEMPRE "Folios A4 LUMA" (stock:206) — HAY STOCK (206 unidades), son paquetes de 10. NUNCA resmas, NUNCA carpetas, NUNCA biblioratos.
   - "fibron" / "fibrón" / "fibrones" → SIEMPRE matchear con fibras/marcadores de color (ej: "FIBRA COLOR X10 TRABI MEGA"). NUNCA recomendar marcadores para pizarra (Edding, Trabi pizarra, etc.) salvo que explícitamente diga "para pizarra".
   - "tijera" / "tijeras" → NUNCA recomendar tijera para zurdos salvo que el ítem diga explícitamente "zurdo" o "zurdos".
   - "voligoma" → SIEMPRE matchear con "Adhesivo VOLIGOMA" (stock:43). No buscar alternativas.
   - "lapiz" / "lápiz" / "lápices" → NUNCA recomendar bolígrafo, birome ni lapicera. Siempre recomendar un lápiz (negro o de colores según contexto).
   - "resma" / "resmas" → SIEMPRE se refiere a hojas A4 blancas. Matchear con "RESMA A4 X100 HOJAS LUMA COLOR" u otras resmas A4. Igualmente, "hojas A4" o "hojas de máquina" → resma A4.
   - "afiche color" / "papel afiche" / "papel de color claro" → SIEMPRE matchear con "Papel afiche vs colores" (hoja suelta). NUNCA recomendar un block de dibujo para esta búsqueda.
   - "pote de acrílico" / "pintura acrílica" / "acrílico para pintar" → SIEMPRE matchear con pinturas acrílicas en pote como "Base Acrilica Eterna 200 cc" (stock:2), "Set Acrilico Valija ETERNA" (stock:1). NUNCA recomendar marcadores acrílicos ni marcadores en general.
   - "block de afiches" → "Block De Dibujo N° 5 Afiche El Nene" (stock:10). Distinto de "papel afiche" suelto.
   - "goma eva lisa" → "Goma Eva Lisa" (stock:48). NUNCA confundir con juegos de encastre.
   - "goma eva con brillo" / "goma eva glitter" → "Goma Eva C/Glitter" (stock:49).

2. Buscá por CONCEPTO, no por nombre exacto. Reglas críticas de matcheo:

   ⚠️ REGLAS DE EXCLUSIÓN OBLIGATORIAS (nunca ignorar):
   - Si pide "folio" o "folios": SIEMPRE matchear con "Folios A4 LUMA" (stock:206) o "Folios Oficio LUMA" (stock:46). NUNCA con carpetas, biblioratos ni otro producto.
   - Si pide "fibron" / "fibrón" / "marcador grueso": matchear con FIBRAS de color (ej: FIBRA COLOR X10 TRABI MEGA). NUNCA con marcadores para pizarra (Edding, Trabi pizarra, etc.) salvo que diga explícitamente "para pizarra".
   - Si pide "tijera" / "tijeras": matchear con tijeras normales (TIJERA SABONIS, TIJERA PIZZINI, TIJERA SIMBALL). NUNCA elegir tijera para zurdos salvo que la lista diga "para zurdo" o "zurdo".
   - Si pide "voligoma" / "boligoma": matchear SIEMPRE con "Adhesivo VOLIGOMA" (stock:43).
   - ⛔ REGLA ABSOLUTA: Si pide "lápiz" / "lapiz" en CUALQUIER forma: JAMÁS devolver bolígrafo, lapicera, birome ni portaminas. Solo lápices de grafito o de colores.
   - ⛔ REGLA ABSOLUTA: Si pide "borrador" / "goma de borrar": SIEMPRE y ÚNICAMENTE "Goma de Borrar 2 BANDERAS Classic" (stock:497). Sin excepciones.
   - ⛔ REGLA ABSOLUTA: Si pide "folio" / "folios": JAMÁS devolver resmas de papel. Folios son hojas plásticas para carpeta. SIEMPRE "Folios A4 LUMA" (stock:206).
   - ⛔ REGLA ABSOLUTA: Si pide "cuaderno A4 tapa dura rayado": SIEMPRE "CUADERNO ESP. ABC RIVADAVIA x100 HOJAS". NUNCA cuadernos Oxford. No buscar otro adhesivo.
   - Si pide "lápiz" / "lapiz" (negro o de color): NUNCA matchear con bolígrafo, lapicera ni birome. Siempre un lápiz.
   - Si pide "resma" / "resmas" sin especificar: SIEMPRE matchear con resma A4 (ej: "RESMA A4 X100 HOJAS LUMA COLOR"). Viceversa: "hojas A4" o "papel A4" = resma A4.
   - Si pide "afiche de color claro" / "papel afiche" / "afiche color": NUNCA recomendar un block. Buscar "Papel afiche vs colores" (aunque tenga stock 0, es el producto correcto — indicar al cliente que consulte disponibilidad). Si hay stock de ese producto, mostrarlo.
   - Si pide "pote de acrílico" / "pintura acrílica" / "acrílico" para arte: recomendar "Base Acrilica Eterna 200 cc" (stock:2) o "Set Acrilico Valija ETERNA". NUNCA recomendar marcadores acrílicos ni impermeabilizante.

   Equivalencias válidas:
   - "tijerita" = "tijera" (cualquier tijera del catálogo)
   - "papel afiche" / "afiches" = "Block De Dibujo N° 5 Afiche El Nene" u otro afiche disponible (NO "Bandera de Argentina", NO "Encastre Mapa")
   - "mapa Argentina" / "mapa división política" = buscar "MAPAS POLITICO" o "Mapa Mural" — NUNCA "Bandera de Argentina"
   - "mapa planisferio" / "planisferio" = "Mapa Mural Planisferio" — NUNCA confundir con bandera
   - "mapa continente americano" = "Mapa Mural America" 
   - "cuaderno ABC" / "cuaderno espiral ABC 100 hojas" = "CUADERNO ESP. ABC RIVADAVIA x100 HOJAS" o "CUADERNOS ESP.ABC RIVADAVIA" — NO cuadernos Oxford ni Norpac
   - "cuaderno de comunicaciones" / "cuaderno comunicados" / "cuaderno de comunicados" / "cuaderno de comunicaciones" = SIEMPRE "CUADERNO DE COMUNICACIONES LAPRIDA" (stock:10). "comunicados" y "comunicaciones" son la misma cosa. — NO ignorar este producto
   - "fibron para pizarra" / "fibrón pizarra" = "Marcador Edding 160 P/Pizarra" o "Marcador P/ Pizarra Recargable TRABI"
   - "block canson N°3" / "hojas color N°3" = "Repuesto" de hojas para carpeta N3 (ej: REPUESTO RIVADAVIA N3, REPUESTO TRIUNFANTE N3)
   - "sacapuntas" = SIEMPRE "SACAPUNTA MAPED METAL SATELITE GRIS" (stock:5) o "SACAPUNTA MAPED METAL 2 BOCAS" (stock:4) — HAY STOCK, nunca marcar como sin stock. Alternativas: SACAPUNTA FILGO METAL (stock:18), SACAPUNTA MAPED VIVO MONSTER (stock:8)
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
   - Artículos de educación física (palo de hockey, bocha, protector bucal, canilleras, equipo deportivo, remera colegio, zapatillas): NO están en catálogo
   - Libros escolares (libros de inglés, libros de matemática, Team Together, Biblias, libros de cuento para el jardín): NO están en catálogo — indicar que consulten con un asesor o librería especializada
   - Rodillo de pintura: NO está en catálogo
   - Papel araña: NO está en catálogo
   - Crayones cremosos específicos: no existe esa variante — ofrecer "Crayones X12 Maped" como alternativa
   - Juego didáctico / juego de memoria / rompecabezas: NO están en catálogo
   - Pulverizador / rociador: NO está en catálogo
   - Botones, telas, lanillas, broches de madera: NO están en catálogo
   - Tablet: NO está en catálogo
   - Taza, servilleta, cepillo de dientes: NO están en catálogo
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
   - "cartulina lisa" = "Cartulina Lisa Varios Colores" 
   - "barritas de silicona gruesa" = "Barra Adhesiva de Silicona P/Pistola"
   - "globos de colores" = "GLOBOS TUKY" (stock:2+) — NUNCA "globo terraqueo"
   - "goma eva lisa" = "Goma Eva Lisa" (stock:48) — existe en catálogo
   - "goma eva con brillo" / "goma eva glitter" = "Goma Eva C/Glitter" (stock:49)
   - "papel glase metalizado" / "PAQ papel glase metalizado" / "papel glasé metalizado" = "Papel Glace Metalizado Surtido Luma" (stock:90)
   - "papel glase fluo" / "PAQ papel glase fluo" / "papel glasé flúor" = "Papel Glace Fluo Surtido Luma" (stock:95)
   - "papel glase opaco" / "PAQ de papel glase opaco" / "papel glasé mate" / "papel glasé lustre" = "Papel Glace Lustre Surtido Luma" (stock:80)
   - "sobres de papel glase" / "sobres papel glase" / "papel glase" / "papel glasé" / "papel glace" (sin especificar tipo) = SIEMPRE "Papel Glace Lustre Surtido Luma" (stock:78) por defecto. Si especifica tipo: fluo→Papel Glace Fluo (stock:95), metalizado→Papel Glace Metalizado (stock:90), lustre/mate/opaco→Papel Glace Lustre (stock:78). Si dice "1 metalizado, 1 lustre, 1 fluo" o "1 fluo, 1 mate, 1 metalizado" son SIEMPRE 3 productos distintos: matchear cada uno con su producto. "mate" = Lustre
   - "cinta de embalar" / "cinta embalar" / "cinta scotch" = "Cintas Adhesivas AUCA 48x50" (stock:16)
   - "plasticola con glitter" / "adhesivo con glitter" / "cola vinilica glitter" = "Adhesivo Plasticola Color 40 Cc" (stock:8) — es lo más cercano disponible
   - "block de afiches" / "block afiches" / "bloque afiches" = "Block De Dibujo N° 5 Afiche El Nene" (stock:10)
   - "block de cartulinas" / "block cartulinas" / "block de cartulinas entretenidas" = "Block De Dibujo N° 5 Color El Nene" (stock:8) o "Block Cartulina Fantasia N° 5 El Nene" (stock:14)
   - "block de hojas de papel madera" / "block papel madera" = "Block Papel Madera MURESCO" (stock:3) o "Papel Madera 80x100" (stock:60)
   - "pincel numero 4" / "pincel n4" / "pincel escolar" = "Set De Pinceles Chatos X 8 Sabonis" (stock:6) o "Set de Pinceles Escolares Olami" (stock:1) — mencionar que se vende en set
   - "fibron" / "felpon" = "fibra" / "marcador"  
   - "birome" = "boligrafo"
   - "plasticola" = cualquier adhesivo similar
   - "PAQ papel glase opaco" = "Papel Glace Lustre" (el más parecido disponible)
   - "voligoma" / "boligoma" = adhesivo cola vinílica
   - "lapiz negro" = cualquier lapiz negro del catálogo
   - "crayones" = cualquier caja de crayones
   - "tempera" = cualquier tempera disponible
   - "plastilinas" / "plastilina" = elegí SIEMPRE la que tenga stock > 0: "Plastilina X10 Alba" (stock:15), "Plastilina X6 Alba" (stock:18) o "Plastilinas PELIKAN Pastel" (stock:10). NUNCA elijas "Plastilina Escolar KEYROAD" que tiene stock:0
   - "tizas" / "caja de tizas" / "1 caja de tizas" = "Tiza Color PLAYCOLOR X12" (stock:9) o "Tiza Blanca x 12 Playcolor" (stock:9). SIEMPRE matchear — hay stock
   - "hojas A4 blancas" / "hojas de máquina A4" = "Hoja A4 Blanca x50 U."
   - "hojas A4 de colores" / "hojas de máquina A4 de colores" = "RESMA A4 210X219X100H.LUMA COLOR" o similar con stock
   - REGLA CRÍTICA: El stock del catálogo indica unidades del PAQUETE en depósito, NO la cantidad de items del producto. Si el cliente pide 10 plastilinas, elegí cualquier plastilina con stock > 0 sin importar si el stock es 5, 15 o 100. El stock NO necesita ser >= la quantity pedida.

3. Si el ítem tiene un prefijo como "PAQ", "CAJA DE", "SET DE", ignoralo y matcheá el producto principal.

4. La cantidad (quantity) ya viene definida — NO la cambies.

5. El subtotal = unitPrice × quantity.

6. Solo usá matched:false si genuinamente no existe ningún producto similar en el catálogo (ej: "colorante vegetal", "cortante de masa"). Si existe algo parecido con stock, siempre matcheá.

Devolvé SOLO un array JSON válido con este formato exacto, sin texto adicional:
[{"requestedItem":"nombre solicitado","quantity":1,"matched":true,"catalogId":1,"catalogName":"nombre producto","catalogSku":"SKU del producto","unitPrice":1000,"subtotal":1000,"confidence":"high"}]

Si no encontrás un producto similar, usá matched:false, catalogId:null, catalogName:null, catalogSku:null, unitPrice:0, subtotal:0.
Respondé ÚNICAMENTE con el JSON, empezando con [ y terminando con ].`;

  const prompt = `Este PDF contiene una lista de útiles escolares. Puede ser una tabla con columnas por grado.

Tenés este catálogo de productos de una librería:
${catalogText}

PASO 1 - EXTRAER: Leé todos los productos únicos de la lista.
- Si es una tabla por grado, listá cada producto UNA sola vez con quantity:1
- Si el número describe el contenido del paquete, quantity:1
- Ignorar encabezados, fechas, artículos de higiene y educación física

PASO 2 - MATCHEAR: Para cada producto extraído, encontrá el más parecido del catálogo.
` + MATCHING_RULES_BLOCK;

  const text = await callAnthropic([{
    role: "user",
    content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
      { type: "text", text: prompt }
    ]
  }]);
  return safeJsonParse(text);
}


// ─── REGLAS HARDCODEADAS (se aplican DESPUÉS de la IA, son inviolables) ──────
// La IA puede equivocarse en el prompt. Estas reglas en código JS nunca fallan.
const HARDCODED_RULES = [
  {
    // voligoma / boligoma (incluso "plasticola o boligoma") → SIEMPRE Adhesivo VOLIGOMA
    // IMPORTANTE: esta regla va ANTES que la de birome para que "boligoma" no caiga en birome
    test: (item) => /voligoma|boligoma/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "Adhesivo VOLIGOMA",
      catalogSlug: "adhesivo-voligoma",
    }
  },
  {
    // birome / lapicera / boligrafo → SIEMPRE Bic 0,7 Punta Fina Cristal
    // No matchea si ya fue capturado por la regla de voligoma/boligoma
    test: (item) => /\b(birome|lapicera|boligrafo)\b/i.test(item.requestedItem) &&
                    !/frixion|borrable|cartucho|tinta\s+borrable/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "Boligrafo Bic 0,7 Punta Fina Cristal",
      catalogSlug: "boligrafo-bic-07-punta-fina-cristal",
    }
  },
  {
    // folio / folios → SIEMPRE Folios A4 LUMA
    test: (item) => /^folios?\b/i.test(item.requestedItem.trim()) ||
                    /\bfolios?\s*(a4|n[°o]?\s*3|plástico|para\s+carpeta|\(\d+\s*anillo)/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "Folios A4 LUMA",
      catalogSlug: "folios-a4-luma",
    }
  },
  {
    // sacapuntas / sacapunta → SIEMPRE SACAPUNTA MAPED METAL SATELITE GRIS
    test: (item) => /\bsacapuntas?\b/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "SACAPUNTA MAPED METAL SATELITE GRIS",
      catalogSlug: "sacapunta-maped-metal-satelite-gris-18a8h",
    }
  },
  {
    // cuaderno de comunicados / comunicaciones → SIEMPRE CUADERNO DE COMUNICACIONES LAPRIDA
    test: (item) => /comunicad[oa]s?|comunicaciones/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "CUADERNO DE COMUNICACIONES LAPRIDA",
      catalogSlug: "cuaderno-de-comunicaciones-laprida-8xf4j",
    }
  },
  {
    // papel glasé / glase / glace (genérico) → Papel Glace Lustre Surtido Luma
    test: (item) => /papel\s+(glas[eé]|glace)/i.test(item.requestedItem) &&
                    !/fluo|flu[oó]|metaliz|lustre|mate|opaco/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "Papel Glace Lustre Surtido Luma",
      catalogSlug: "papel-glace-lustre-surtido-luma",
    }
  },
  {
    // corrector / liquido corrector / liquid paper → Liquido Corrector PIZZINI
    test: (item) => /corrector|liquid[o]?s*paper/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "Liquido Corrector PIZZINI",
      catalogSlug: "liquido-corrector-pizzini",
    }
  },
  {
    // cinta de papel → Cinta de Papel Auca
    test: (item) => /cintas+des+papel/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "Cinta de Papel Auca",
      catalogSlug: "cinta-de-papel-auca",
    }
  },
  {
    // cinta de embalar / cinta scotch / cinta adhesiva → Cintas Adhesivas AUCA 48x50
    test: (item) => /cintas+des+embalar|cintas+embalar|cintas+scotch/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "Cintas Adhesivas AUCA 48x50",
      catalogSlug: "cintas-adhesivas-auca-48x50",
    }
  },
  {
    // resma A4 / hojas A4 → Resmas A4 AUTOR (solo en sucursal)
    test: (item) => /resma|hoja.*a4|a4.*hoja|papel.*a4|a4.*papel/i.test(item.requestedItem) &&
                    !/oficio|legal/i.test(item.requestedItem),
    override: {
      matched: true,
      inStoreOnly: true,
      catalogName: "Resmas A4 AUTOR",
      catalogSlug: "resmas-a4-autor",
    }
  },
  {
    // resma oficio → según gramaje si se especifica, sino Resma Oficio Autor 75 grs. por defecto
    test: (item) => /resma.*oficio|oficio.*resma|hoja.*oficio|oficio.*hoja|papel.*oficio|oficio.*papel/i.test(item.requestedItem),
    override: {
      matched: true,
      inStoreOnly: true,
      catalogName: "Resma Oficio Autor 75 grs.",
      catalogSlug: "resma-oficio-autor-75-grs",
    }
  },
  {
    // block canson / hojas de colores N5 → Block De Dibujo N° 5 Color El Nene
    test: (item) => /(block|hojas?).*(color|colores).*(n[°o]?s*5|5)|canson.*colores?.*5|colores?.*canson.*5/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "Block De Dibujo N° 5 Color El Nene",
      catalogSlug: "block-de-dibujo-n-5-color-el-nene",
    }
  },
  {
    // pote de tempera (cualquier variante: "pote de tempera de color", etc.)
    test: (item) => /pote/i.test(item.requestedItem) && /t[eé]mpera/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "Tempera Alba Magic En Pote X 275G",
      catalogSlug: "tempera-alba-magic-en-pote-x-275g",
    }
  },
  {
    // plasticola blanca → Adhesivo Escolar STA
    test: (item) => /plasticola/i.test(item.requestedItem) && /blanc[ao]/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "Adhesivo Escolar STA",
      catalogSlug: "adhesivo-escolar-sta",
    }
  },
  {
    // plasticola de color / plasticolas de colores → Adhesivo Plasticola Color 40 Cc
    test: (item) => /plasticola/i.test(item.requestedItem) && /color(es)?/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "Adhesivo Plasticola Color 40 Cc",
      catalogSlug: "adhesivo-plasticola-color-40-cc",
    }
  },
  {
    // papel madera → Papel Madera 80x100
    test: (item) => /papel\s+madera/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "Papel Madera 80x100",
      catalogSlug: "papel-madera-80x100",
    }
  },
  {
    // cartulina / cartulina de color → Cartulina Lisa Varios Colores (excluye metalizada)
    test: (item) => /cartulina/i.test(item.requestedItem) && !/metaliz/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "Cartulina Lisa Varios Colores",
      catalogSlug: "cartulina-lisa-varios-colores",
    }
  },
  {
    // afiche / afiche de color / papel afiche → Papel afiche vs colores (excluye block de afiches)
    test: (item) => /afiche/i.test(item.requestedItem) && !/block/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "Papel afiche vs colores",
      catalogSlug: "papel-afiche-vs-colores",
    }
  },
  {
    // fibra permanente / fibron permanente / marcador permanente → Marcador Edding 400 Permanente
    test: (item) => /permanente/i.test(item.requestedItem) &&
                    /fibra|fibr[oó]n|marcador|felp[oó]n/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "Marcador Edding 400 Permanente",
      catalogSlug: "marcador-edding-400-permanente",
    }
  },
];
  {
    // tijerita / tijera punta redonda → TIJERA FILGO ESCOLAR PINTO
    test: (item) => /tijerita|tijeras+puntas+redonda|tijeras+escolar/i.test(item.requestedItem),
    override: {
      matched: true,
      catalogName: "TIJERA FILGO ESCOLAR PINTO",
      catalogSlug: "tijera-filgo-escolar-pinto-utcln",
    }
  },

function applyHardcodedRules(matchedItems, catalogByName) {
  matchedItems.forEach(item => {
    for (const rule of HARDCODED_RULES) {
      if (rule.test(item)) {
        const prod = catalogByName[rule.override.catalogName.toLowerCase().trim()];
        const unitPrice = prod ? prod.price : (item.unitPrice || 0);
        const qty = item.quantity || 1;
        Object.assign(item, rule.override, {
          catalogId: prod ? prod.id : item.catalogId,
          catalogSku: prod ? prod.sku : item.catalogSku,
          unitPrice,
          subtotal: unitPrice * qty,
          // inStoreOnly: indica que el producto no se vende online, solo en sucursal
          inStoreOnly: rule.override.inStoreOnly || false,
        });
        break;
      }
    }
  });
  return matchedItems;
}

// ─── ENDPOINT PRINCIPAL ────────────────────────────────────────────
app.post("/api/presupuestar", upload.single("lista"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No se recibió ningún archivo" });

  try {
    let matchedItems;

    if (IMAGE_TYPES.includes(file.mimetype)) {
      // IMAGEN: parseo + matching en 1 sola llamada
      matchedItems = await parseAndMatchFromImage(file.path, file.mimetype);

    } else {
      const rawText = await extractText(file.path, file.mimetype);

      const isGarbled = !rawText || rawText.trim().length < 10 ||
        (rawText.split("\n").filter(l => l.trim()).length < 3 && rawText.length > 50);

      if (isGarbled && file.mimetype === "application/pdf") {
        // PDF con tablas/imagen: parseo + matching en 1 sola llamada
        try {
          matchedItems = await parseAndMatchFromPdfVision(file.path);
        } catch (visionErr) {
          return res.status(400).json({ error: "No se pudo leer el archivo. Intentá con una foto de la lista." });
        }
      } else if (!rawText || rawText.trim().length < 10) {
        return res.status(400).json({ error: "No se pudo leer texto del archivo." });
      } else {
        // TEXTO/PDF legible: parseo + matching en 1 sola llamada
        try {
          matchedItems = await parseAndMatchFromText(rawText);
        } catch (aiErr) {
          // Fallback: intentar con visión si es PDF
          if (file.mimetype === "application/pdf") {
            matchedItems = await parseAndMatchFromPdfVision(file.path);
          } else {
            throw aiErr;
          }
        }
      }
    }

    // Enriquecer con slug de URL — buscar por SKU (más confiable que por ID)
    const catalogBySku = Object.fromEntries(
      CATALOG.filter(p => p.sku).map(p => [String(p.sku).trim(), p])
    );
    const catalogByName = {};
    CATALOG.forEach(p => { catalogByName[p.name.toLowerCase().trim()] = p; });

    // ⚡ Aplicar reglas hardcodeadas ANTES de enriquecer slugs
    // Estas reglas son inviolables — corrigen cualquier error de la IA
    applyHardcodedRules(matchedItems, catalogByName);

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

    const found = matchedItems.filter((i) => i.matched && !i.inStoreOnly);
    const inStore = matchedItems.filter((i) => i.matched && i.inStoreOnly);
    const notFound = matchedItems.filter((i) => !i.matched);
    const total = found.reduce((sum, i) => sum + i.subtotal, 0);
    const coverage = Math.round(((found.length + inStore.length) / matchedItems.length) * 100);

    res.json({
      success: true,
      summary: {
        totalItems: matchedItems.length,
        foundItems: found.length,
        inStoreItems: inStore.length,
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

// ─── GENERAR PDF DE PRESUPUESTO ──────────────────────────────────────
app.post("/api/presupuesto-pdf", express.json({ limit: "2mb" }), (req, res) => {
  const { items, summary, schoolName } = req.body;
  if (!items || !summary) {
    return res.status(400).json({ error: "Faltan datos del presupuesto" });
  }

  const found    = items.filter(i => i.matched);
  const notFound = items.filter(i => !i.matched);
  const total    = summary.estimatedTotal || found.reduce((s, i) => s + (i.subtotal || 0), 0);

  // ── Helpers de formato ──────────────────────────────────────────
  const fmt = (n) => "$" + Number(n).toLocaleString("es-AR", { minimumFractionDigits: 2 });
  const pad = (s, len) => String(s).slice(0, len).padEnd(len);
  const padL = (s, len) => String(s).slice(0, len).padStart(len);

  // ── Colores y medidas ───────────────────────────────────────────
  const GREEN  = "#2d7a3a";
  const LGRAY  = "#f5f5f5";
  const DGRAY  = "#666666";
  const RED    = "#c0392b";
  const BLACK  = "#1a1a1a";
  const WHITE  = "#ffffff";
  const PAGE_W = 595.28;  // A4
  const PAGE_H = 841.89;
  const ML = 40; const MR = 40;
  const CONTENT_W = PAGE_W - ML - MR;

  // ── Construir PDF con pdfkit ────────────────────────────────────
  let PDFDocument;
  try { PDFDocument = require("pdfkit"); }
  catch(e) { return res.status(500).json({ error: "pdfkit no instalado. Agregalo al package.json." }); }

  const doc = new PDFDocument({ size: "A4", margin: 0, info: {
    Title: "Presupuesto Escolar - Librería Lerma",
    Author: "Librería Lerma"
  }});

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="presupuesto-lerma.pdf"`);
  doc.pipe(res);

  let y = 0;

  // ── Función para nueva página ───────────────────────────────────
  function newPage() {
    doc.addPage({ size: "A4", margin: 0 });
    y = 0;
    drawHeader();
  }

  function checkPage(needed = 20) {
    if (y + needed > PAGE_H - 60) newPage();
  }

  // ── HEADER ──────────────────────────────────────────────────────
  function drawHeader() {
    doc.rect(0, 0, PAGE_W, 70).fill(GREEN);
    doc.fillColor(WHITE).fontSize(22).font("Helvetica-Bold")
       .text("Librería Lerma", ML, 18);
    doc.fontSize(10).font("Helvetica")
       .text("Presupuesto Escolar 2026", ML, 44);
    const dateStr = new Date().toLocaleDateString("es-AR", { day:"2-digit", month:"2-digit", year:"numeric" });
    doc.text(dateStr, PAGE_W - MR - 80, 44, { width: 80, align: "right" });
    y = 85;
  }

  // ── PRIMERA PÁGINA ──────────────────────────────────────────────
  drawHeader();

  // Sub-header con nombre del colegio si lo hay
  if (schoolName) {
    doc.fillColor(DGRAY).fontSize(11).font("Helvetica-Oblique")
       .text(schoolName, ML, y, { width: CONTENT_W });
    y += 20;
  }

  // Resumen ejecutivo
  doc.rect(ML, y, CONTENT_W, 56).fillAndStroke(LGRAY, "#dddddd");
  doc.fillColor(BLACK).fontSize(10).font("Helvetica-Bold")
     .text("Resumen del presupuesto", ML + 12, y + 10);
  doc.font("Helvetica").fontSize(9).fillColor(DGRAY)
     .text(`Artículos encontrados: ${found.length} de ${items.length}  |  Artículos no disponibles: ${notFound.length}`, ML + 12, y + 26);
  doc.font("Helvetica-Bold").fontSize(14).fillColor(GREEN)
     .text(fmt(total), PAGE_W - MR - 120, y + 18, { width: 110, align: "right" });
  doc.font("Helvetica").fontSize(8).fillColor(DGRAY)
     .text("TOTAL ESTIMADO", PAGE_W - MR - 120, y + 36, { width: 110, align: "right" });
  y += 72;

  // ── TABLA: ARTÍCULOS DISPONIBLES ────────────────────────────────
  if (found.length > 0) {
    // Título sección
    doc.fillColor(GREEN).fontSize(12).font("Helvetica-Bold")
       .text("✓ Artículos disponibles", ML, y);
    y += 18;

    // Cabecera tabla
    const COL = { qty: 35, sku: 70, name: 230, unit: 80, sub: 80 };
    function tableHeader() {
      doc.rect(ML, y, CONTENT_W, 20).fill(GREEN);
      doc.fillColor(WHITE).fontSize(8).font("Helvetica-Bold");
      let x = ML + 6;
      doc.text("CANT.",  x, y + 6, { width: COL.qty });  x += COL.qty;
      doc.text("SKU",    x, y + 6, { width: COL.sku });  x += COL.sku;
      doc.text("PRODUCTO", x, y + 6, { width: COL.name }); x += COL.name;
      doc.text("P. UNIT.", x, y + 6, { width: COL.unit, align: "right" }); x += COL.unit;
      doc.text("SUBTOTAL", x, y + 6, { width: COL.sub - 6, align: "right" });
      y += 20;
    }

    tableHeader();

    found.forEach((item, idx) => {
      checkPage(24);
      // Reprint header if new page
      if (y === 85) tableHeader();

      const bg = idx % 2 === 0 ? WHITE : LGRAY;
      doc.rect(ML, y, CONTENT_W, 22).fill(bg);
      doc.strokeColor("#dddddd").rect(ML, y, CONTENT_W, 22).stroke();

      doc.fillColor(BLACK).fontSize(8).font("Helvetica-Bold");
      let x = ML + 6;
      doc.text(String(item.quantity || 1), x, y + 7, { width: COL.qty }); x += COL.qty;

      doc.font("Helvetica").fillColor(DGRAY)
         .text(item.catalogSku || item.catalogId || "-", x, y + 7, { width: COL.sku }); x += COL.sku;

      doc.fillColor(BLACK)
         .text(item.catalogName || item.requestedItem || "", x, y + 7, { width: COL.name - 6 }); x += COL.name;

      doc.fillColor(DGRAY)
         .text(fmt(item.unitPrice || 0), x, y + 7, { width: COL.unit, align: "right" }); x += COL.unit;

      doc.fillColor(GREEN).font("Helvetica-Bold")
         .text(fmt(item.subtotal || 0), x, y + 7, { width: COL.sub - 6, align: "right" });
      y += 22;
    });

    // Total
    y += 4;
    doc.rect(ML, y, CONTENT_W, 28).fill(GREEN);
    doc.fillColor(WHITE).fontSize(11).font("Helvetica-Bold")
       .text("TOTAL ESTIMADO", ML + 12, y + 8);
    doc.fontSize(13)
       .text(fmt(total), ML, y + 7, { width: CONTENT_W - 10, align: "right" });
    y += 36;
  }

  // ── TABLA: ARTÍCULOS NO DISPONIBLES ─────────────────────────────
  if (notFound.length > 0) {
    checkPage(40);
    y += 12;
    doc.fillColor(RED).fontSize(12).font("Helvetica-Bold")
       .text("⚠ Artículos no disponibles en catálogo", ML, y);
    doc.fontSize(8).font("Helvetica").fillColor(DGRAY)
       .text("Consultá disponibilidad con un asesor en la tienda o por WhatsApp.", ML, y + 16);
    y += 32;

    // Cabecera
    doc.rect(ML, y, CONTENT_W, 20).fill(RED);
    doc.fillColor(WHITE).fontSize(8).font("Helvetica-Bold");
    let x = ML + 6;
    doc.text("CANT.", x, y + 6, { width: 40 }); x += 40;
    doc.text("ARTÍCULO SOLICITADO", x, y + 6, { width: CONTENT_W - 50 });
    y += 20;

    notFound.forEach((item, idx) => {
      checkPage(22);
      const bg = idx % 2 === 0 ? "#fff5f5" : WHITE;
      doc.rect(ML, y, CONTENT_W, 20).fill(bg);
      doc.strokeColor("#f0bbbb").rect(ML, y, CONTENT_W, 20).stroke();

      let x = ML + 6;
      doc.fillColor(RED).fontSize(8).font("Helvetica-Bold")
         .text(String(item.quantity || 1), x, y + 6, { width: 40 }); x += 40;
      doc.fillColor(BLACK).font("Helvetica")
         .text(item.requestedItem || "", x, y + 6, { width: CONTENT_W - 50 });
      y += 20;
    });
  }

  // ── FOOTER ──────────────────────────────────────────────────────
  const footerY = PAGE_H - 40;
  doc.rect(0, footerY, PAGE_W, 40).fill(GREEN);
  doc.fillColor(WHITE).fontSize(8).font("Helvetica")
     .text("Librería Lerma  |  Belgrano 635, Salta  |  Tel: 0387-4314736  |  librerialerma.com.ar",
           ML, footerY + 14, { width: CONTENT_W, align: "center" });

  doc.end();
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
