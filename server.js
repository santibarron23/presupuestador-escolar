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
async function callAnthropic(messages, maxTokens = 4000) {
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
}

// ─── PARSEAR + MATCHEAR TEXTO EN 1 SOLA LLAMADA ──────────────────────
async function parseAndMatchFromText(rawText) {
  const dummyItems = buildDummyItems(rawText);
  const catalogText = buildCatalogText(dummyItems);

  const MATCHING_RULES_BLOCK = `Para cada ítem de la lista, encontrá el producto más parecido del catálogo. Reglas:

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
   - "globos de colores" = "GLOBOS TUKY" (stock:2+) — NUNCA "globo terraqueo"
   - "goma eva lisa" = "Goma Eva Lisa" (stock:48) — existe en catálogo
   - "goma eva con brillo" / "goma eva glitter" = "Goma Eva C/Glitter" (stock:49)
   - "papel glase metalizado" / "PAQ papel glase metalizado" / "papel glasé metalizado" = "Papel Glace Metalizado Surtido Luma" (stock:90)
   - "papel glase fluo" / "PAQ papel glase fluo" / "papel glasé flúor" = "Papel Glace Fluo Surtido Luma" (stock:95)
   - "papel glase opaco" / "PAQ de papel glase opaco" / "papel glasé mate" / "papel glasé lustre" = "Papel Glace Lustre Surtido Luma" (stock:80)
   - "sobres de papel glase" / "sobres papel glase" / "papel glase" (genérico) → matchear con Papel Glace Lustre, Fluo o Metalizado según contexto. Si dice "1 metalizado, 1 lustre, 1 fluo" son 3 productos distintos
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
   - "tizas" / "caja de tizas" = "Tiza Color X12 KOBY" u otras tizas con stock
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

  const MATCHING_RULES_BLOCK = `Para cada ítem de la lista, encontrá el producto más parecido del catálogo. Reglas:

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
   - "globos de colores" = "GLOBOS TUKY" (stock:2+) — NUNCA "globo terraqueo"
   - "goma eva lisa" = "Goma Eva Lisa" (stock:48) — existe en catálogo
   - "goma eva con brillo" / "goma eva glitter" = "Goma Eva C/Glitter" (stock:49)
   - "papel glase metalizado" / "PAQ papel glase metalizado" / "papel glasé metalizado" = "Papel Glace Metalizado Surtido Luma" (stock:90)
   - "papel glase fluo" / "PAQ papel glase fluo" / "papel glasé flúor" = "Papel Glace Fluo Surtido Luma" (stock:95)
   - "papel glase opaco" / "PAQ de papel glase opaco" / "papel glasé mate" / "papel glasé lustre" = "Papel Glace Lustre Surtido Luma" (stock:80)
   - "sobres de papel glase" / "sobres papel glase" / "papel glase" (genérico) → matchear con Papel Glace Lustre, Fluo o Metalizado según contexto. Si dice "1 metalizado, 1 lustre, 1 fluo" son 3 productos distintos
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
   - "tizas" / "caja de tizas" = "Tiza Color X12 KOBY" u otras tizas con stock
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

  const MATCHING_RULES_BLOCK = `Para cada ítem de la lista, encontrá el producto más parecido del catálogo. Reglas:

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
   - "globos de colores" = "GLOBOS TUKY" (stock:2+) — NUNCA "globo terraqueo"
   - "goma eva lisa" = "Goma Eva Lisa" (stock:48) — existe en catálogo
   - "goma eva con brillo" / "goma eva glitter" = "Goma Eva C/Glitter" (stock:49)
   - "papel glase metalizado" / "PAQ papel glase metalizado" / "papel glasé metalizado" = "Papel Glace Metalizado Surtido Luma" (stock:90)
   - "papel glase fluo" / "PAQ papel glase fluo" / "papel glasé flúor" = "Papel Glace Fluo Surtido Luma" (stock:95)
   - "papel glase opaco" / "PAQ de papel glase opaco" / "papel glasé mate" / "papel glasé lustre" = "Papel Glace Lustre Surtido Luma" (stock:80)
   - "sobres de papel glase" / "sobres papel glase" / "papel glase" (genérico) → matchear con Papel Glace Lustre, Fluo o Metalizado según contexto. Si dice "1 metalizado, 1 lustre, 1 fluo" son 3 productos distintos
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
   - "tizas" / "caja de tizas" = "Tiza Color X12 KOBY" u otras tizas con stock
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
