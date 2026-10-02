# Auditoría — Presupuestador escolar Librería Lerma

Fecha: 2026-10-02 · Alcance: repositorio `santibarron23/presupuestador-escolar` (commit `95febf7`) y versión publicada en
`https://librerialerma.com.ar/presupuesta-tu-lista-escolar/` (iframe a `https://presupuestador-escolar.onrender.com/widget`).

Todo lo que dice "verificado" se comprobó ejecutando código o llamando a la versión publicada, no por lectura.

---

## 0. Estado en producción (verificado)

| Hecho | Evidencia |
|---|---|
| **El presupuestador está caído.** Toda lista devuelve error. | `POST /api/presupuestar` con un .txt → `{"error":"Error procesando la lista: Request failed with status code 404"}`. El modelo `claude-sonnet-4-20250514` hardcodeado ya no está disponible. Afecta las 3 vías (texto, imagen, PDF) porque todas usan `callAnthropic`. |
| **`main` no compila.** | El commit `95febf7` (10/08) reemplazó la línea `app.post("/api/presupuesto-pdf", …` por tres comandos de git pegados (`server.js:1312-1314`). `node --check server.js` → `SyntaxError: Unexpected identifier 'add'`. Render sigue sirviendo un build anterior; cualquier deploy desde `main` falla. |
| **Precios desactualizados.** | El catálogo servido es idéntico a `catalog.json` (snapshot de febrero). Muestra de 8 productos contra la tienda: entre 1 % y 54 % más barato que el precio real (Folios A4 LUMA $1400 vs $1950; Papel Glacé Lustre $250 vs $385). |
| Widget publicado = `widget.html` del repo | Diff idéntico salvo finales de línea. |
| CORS abierto | `OPTIONS` desde `Origin: https://evil.example` → `access-control-allow-origin: *`. |

---

## 1. Flujo actual completo

```
Usuario (iframe en Tiendanube)
  └─ widget.html: elige 1 archivo → POST multipart /api/presupuestar (campo "lista")
       server.js
       ├─ multer → guarda en disco ./uploads (10 MB)
       ├─ imagen (por mimetype declarado por el cliente)
       │    └─ parseAndMatchFromImage: imagen + 300 primeros productos con stock (por id) + ~120 líneas de reglas → Claude
       ├─ PDF/DOCX/TXT → extractText (pdf-parse / mammoth / utf8)
       │    ├─ texto "ilegible" (heurística de líneas) → parseAndMatchFromPdfVision: PDF + mismos 300 productos → Claude
       │    └─ texto OK → parseAndMatchFromText:
       │          buildDummyItems(texto) → cada palabra >3 letras es un "ítem"
       │          preFilterCatalog: sinónimos + Levenshtein + scoring → hasta 300 productos
       │          prompt: catálogo + texto + ~180 líneas de reglas → Claude (1 sola llamada: extracción + matching)
       │          si falla y es PDF → reintento por visión
       ├─ safeJsonParse (regex sobre la respuesta)
       ├─ applyHardcodedRules: 27 regex que pisan el resultado de la IA
       ├─ enriquecer slug (por SKU → nombre → id)
       └─ totales: suma de subtotal **devuelto por la IA**
  └─ widget: render con innerHTML; "Agregar todo al carrito" abre un modal con links individuales;
     "PDF" = window.print() de una ventana generada en el cliente.
```

Una sola llamada de IA hace extracción y matching a la vez. El modelo ve el catálogo como texto y devuelve id, nombre, SKU,
precio y subtotal; el servidor confía en esos números salvo para las 27 reglas.

---

## 2. Bugs (verificados salvo indicación)

### Críticos
1. **B1 — Modelo retirado:** toda petición falla con 404 (`server.js:252`).
2. **B2 — `server.js` inválido** por comandos de git pegados (`server.js:1312-1314`). Además el endpoint `/api/presupuesto-pdf` quedó sin ruta.
3. **B3 — Precios inventados por la IA:** `unitPrice` y `subtotal` salen de la respuesta del modelo y no se validan contra el catálogo (sólo las 27 reglas re-preciaban). Un error del modelo cambia el total.
4. **B4 — Catálogo desactualizado:** precios de febrero (ver §0).
5. **B5 — XSS en el widget:** `requestedItem`, `catalogName` (texto que viene del documento subido y de la IA) se insertan con `innerHTML` sin escapar (`widget.html:968, 994, 1018, 1230, 1248, 1313`).

### Altos (lógica de matching)
6. **Regex sin barra invertida** (`s+` en lugar de `\s+`): `cintas+des+papel`, `cintas+des+embalar|cintas+embalar|cintas+scotch`, `papers*mate`, `liquid[o]?s*paper`, `n[°o]?s*5`. "cinta de papel" y "cinta scotch" **nunca** matchean la regla.
7. **"marcadores de colores" → Resaltador Faber 48.** La regla de resaltador acepta `marcador` + `color` (`server.js:974-976`).
8. **"40 hojas A4 cuadriculadas para carpeta" (repuesto) → "Resmas A4 AUTOR" solo sucursal, cantidad forzada 1** (`server.js:1056`). Además ignora rayado/cuadriculado.
9. **"biromes" (plural) y "bolígrafo" (con tilde) no matchean** `\b(birome|lapicera|boligrafo)\b`. La regla de "bolígrafo color" contiene caracteres **cirílicos** (`bол[ií]grafo`, `server.js:1016`).
10. **Reglas que apuntan a productos inexistentes** (por nombre exacto): "Perforador Maped Essentials 30/35H", "Block De Dibujo N° 5 Color El Nene", "TIJERA FILGO ESCOLAR PINTO". Resultado: nombre forzado + precio y link **del producto que eligió la IA** (otro producto).
11. **"block de cartulinas" → "Cartulina Lisa Varios Colores"** por regla dura, contradiciendo el prompt.
12. **"Resmas A4 AUTOR" y "Resma Oficio Autor" tienen stock 0** y son el destino forzado de cualquier "hojas A4".
13. **Reglas de texto ≠ reglas de imagen/PDF.** El bloque de texto (`server.js:369-550`) y el de imagen/PDF (`585-711` = `747-873`) son distintos. Misma lista, distinto resultado según formato. Contradicciones concretas: "pincel N°4" (KOBY vs Set Sabonis), "papel afiche" (Papel afiche vs Block El Nene), "plasticola con glitter" (Pelikan vs Plasticola Color), "block de cartulinas" (Fantasía vs Color El Nene), "pote de acrílico" (Base Acrílica vs témpera).
14. **Stock embebido en el prompt** distinto del catálogo (voligoma 43 vs 36; glasé 80 vs 78).
15. **Imagen/PDF escaneado sólo ven los primeros 300 productos con stock por orden de id** (ids 1–385 de 1462 disponibles). Todo lo que esté más abajo no puede matchearse jamás.
16. **Texto: `buildDummyItems` convierte cada palabra de la lista en un "ítem"** para el prefiltro. Una lista larga produce ruido y el corte a 300 productos es arbitrario.

### Medios
17. División por cero: `coverage` es `NaN` si la IA devuelve `[]` (`server.js:1288`).
18. `rule.test(item)` usa `item.requestedItem.trim()` → excepción si la IA omite el campo.
19. `max_tokens: 4000`: una lista larga corta el JSON → error total.
20. Sin timeout en axios; con 429 espera `retry-after` (hasta minutos) mientras el usuario mira un spinner.
21. `.doc` (Word 97) está aceptado en el widget y en el servidor pero `mammoth` no lo lee.
22. Mimetype tomado del cliente; no se valida el contenido real del archivo.
23. Widget: la animación de pasos termina en "Listo" a los 4,8 s aunque falte el 90 % del proceso. `isLoading` compara `style.display === "flex"` pero el loading usa clases → nunca es true.
24. Widget: los no encontrados se rotulan **"Sin stock"** (falso: no existen en catálogo).
25. PDF del servidor: usa glifos `✓`/`⚠` que Helvetica estándar de pdfkit no tiene; año "2026" hardcodeado; footer sólo en la última página; total tomado del body.
26. Productos con precio `$1` en catálogo (22 de higiene/limpieza): se presupuestarían a $1.
27. 148 nombres y 371 descripciones con encoding roto (`N�`, `tama�os`): rompe matcheos por nombre exacto con "N°".
28. 10 SKU duplicados y 5 nombres duplicados → el índice por SKU/nombre elige uno arbitrario.

---

## 3. Hardcodeo excesivo

- ~430 líneas de reglas en prompts (×3 copias divergentes) + 27 reglas regex en código + 60 sinónimos en `KEYWORD_EXPANSIONS`. **Cuatro fuentes de verdad** para la misma decisión.
- Nombres de producto escritos literalmente (frágil: cualquier renombre en la tienda rompe la regla en silencio).
- Stock y precios escritos dentro de prompts.
- Modelo, versión de API, URL del backend (`widget.html:801`), datos de la sucursal, año del presupuesto.

## 4. Qué debe ser determinístico y qué IA

| Determinístico (código + configuración) | IA |
|---|---|
| Precios, stock, totales, cantidades de paquetes | Leer fotos, manuscritos, PDFs escaneados y tablas por grado |
| Sinónimos y lenguaje escolar (plasticola, birome, glasé…) | Separar ítems compuestos ("1 fluo, 1 mate, 1 metalizado") |
| Recuperación de candidatos y ranking | Extraer atributos de texto libre en una estructura (schema) |
| Reglas de compatibilidad (A4≠oficio, lápiz≠birome…) | Desempatar entre ≤5 candidatos ya compatibles, cuando el ranking duda |
| Producto preferido por concepto (reglas comerciales) | — |
| Validación final y nivel de confianza | — |

La IA **nunca** decide precio, stock ni puede devolver un producto que no esté entre los candidatos validados.

## 5. Separación en módulos

`server.js` (1519 líneas) mezcla: HTTP, upload, parsing de archivos, lexicón, fuzzy search, cliente HTTP de la IA,
prompts, reglas, enriquecimiento, totales y generación de PDF. Ver §11 (arquitectura V2).

## 6. Escala: cientos o miles de usuarios

- **Costo sin control:** endpoint abierto a cualquier origen, sin rate limit → cualquiera puede gastar la cuenta de Anthropic.
- Cada presupuesto manda ~300 productos + ~5–8 k tokens de reglas: costo y latencia por presupuesto altos.
- Render (plan con cold start): primer request tras inactividad tarda.
- Uploads a disco local efímero; sin límite de concurrencia hacia la IA → picos de 429/529 que el usuario ve como error.
- Reintentos con espera de hasta minutos bloquean la conexión.
- Un solo proceso, sin métricas: no hay forma de saber qué está fallando en temporada.

## 7. Escala: catálogo grande

- El prefiltro escanea todo el catálogo con Levenshtein por palabra × sinónimo en cada request (O(palabras × sinónimos + productos × keywords)).
- El modelo recibe hasta 300 productos: cuanto más crece el catálogo, más productos relevantes quedan afuera (y en imágenes es directamente el orden por id).
- Nombres literales en reglas: cada producto nuevo/renombrado requiere editar prompts.

## 8. Información sensible expuesta

- `/api/catalogo` publica el catálogo completo con stock exacto (ya visible en la tienda, pero sin necesidad).
- Mensajes de error internos al cliente (`"Error procesando la lista: " + err.message`).
- `x-powered-by: Express`.
- Las listas pueden contener nombres de chicos/colegio: hoy se guardan en disco (`uploads/`) hasta el `unlink` del `finally` (si el proceso se cae a mitad, quedan). Se envían enteras a la IA (necesario), pero no deberían loguearse.
- La API key no está expuesta (correcto: variable de entorno).

## 9. Llamadas innecesarias / tokens desperdiciados

- ~400 líneas de reglas en cada llamada, aunque la lista tenga 5 ítems.
- 300 productos en texto por llamada, la mayoría irrelevantes.
- PDF con texto legible que falla en IA → segunda llamada completa por visión.
- Reintentos 429 con la misma carga completa.
- El modelo calcula subtotales (trabajo determinístico).

## 10–14. Problemas de matching

**Matches incorrectos (10–11):** el modelo elige entre texto plano de 300 productos guiado por reglas contradictorias; luego regex con bugs pisan su decisión. No hay validación posterior de compatibilidad, así que una birome puede salir como "lápiz" si la IA se equivoca.

**Cantidades/packs/variantes (12):** no existe el concepto de "unidades por paquete". "20 folios" → cantidad 20 de un paquete x10 (paga 200 folios) o 1 (según la regla de turno). "10 plastilinas" → la regla dice "la cantidad no es el stock", pero el subtotal multiplica 10 cajas. Tamaños (A4/oficio, N°3/N°5), rayado/cuadriculado y colores se tratan sólo como texto en el prompt. Variantes (color, tamaño) no existen en el catálogo local.

**Producto inexistente (13):** el prompt empuja a matchear "si existe algo parecido" → falsos positivos. Y "Sin stock" se muestra para cosas que no vendemos.

**Varias alternativas válidas (14):** se elige una sola, sin alternativas ni explicación. El usuario no puede cambiarla.

## 15. Mejoras con impacto directo en conversión

1. **Que funcione** (hoy 0 % de conversión).
2. Precios reales = el total coincide con el carrito (confianza).
3. **Carrito real**: agregar todo de una vez desde la página padre (mismo origen que la tienda, ver §12).
4. Imágenes de producto y link directo.
5. Edición: cambiar cantidad, elegir alternativa, quitar, agregar → menos abandono por "no es lo que pidió la maestra".
6. "Pegá tu lista" y "Sacar foto" en celular (hoy sólo selector de archivos).
7. WhatsApp con el presupuesto y lo pendiente → venta asistida de lo no encontrado.
8. Presupuesto compartible (link) para que la familia lo retome o lo reenvíe.
9. Datos de demanda no satisfecha para compras (qué se pidió y no tenemos).

---

## Lista priorizada de problemas

| Prioridad | Problema | Fase |
|---|---|---|
| P0 | Modelo retirado (prod caída) · `server.js` no compila | 0 |
| P0 | Precios de la IA sin validar · precios de febrero | 0 / 1 |
| P0 | Endpoint de IA abierto (CORS `*`, sin rate limit) | 0 |
| P0 | XSS en widget | 0 |
| P1 | Regex rotas, reglas contradictorias, productos inexistentes en reglas | 0 (parche) / 1 (reemplazo) |
| P1 | Imagen/PDF ven 300 productos arbitrarios | 1 |
| P1 | Sin manejo de packs/cantidades | 1 |
| P1 | Sin validación de compatibilidad ni confianza → falsos positivos | 1 |
| P1 | Sin tests | 1 |
| P2 | UX: sin edición, sin alternativas, sin imágenes, carrito falso, "Sin stock" falso | 2 |
| P2 | Sin "pegar lista" / cámara / múltiples fotos | 1 (backend) / 2 (UI) |
| P2 | PDF poco profesional, sin id ni QR | 2 |
| P3 | Sin analytics, sin panel, sin feedback loop | 3 |
| P3 | Sin persistencia de presupuestos | 3 |

---

## 11. Arquitectura V2

Proyecto chico (un servicio, un widget): **un solo servicio Node/Express en CommonJS**, con módulos por responsabilidad y la configuración de negocio en archivos de datos. Sin microservicios, sin base vectorial, sin build step obligatorio para el backend.

```
src/
  app.js                 Express: rutas, seguridad, errores
  config/
    index.js             variables de entorno (modelo, límites, orígenes)
    lexicon.js           lenguaje escolar: conceptos, sinónimos, marcas, "no vendemos"
    matchingRules.js     reglas comerciales: preferidos, excluidos, prioridades, packs
  catalog/
    catalogStore.js      carga, índices (id, sku), búsqueda BM25, hot-reload
    productAttributes.js atributos de producto desde el nombre (concepto, formato, rayado, pack, marca)
    providers/           jsonFile · tiendanubeApi · storefront (sync)
  parsing/
    fileReader.js        validación por magic bytes, PDF/DOCX/TXT a texto (en memoria)
    lineExtractor.js     extracción determinística (fallback sin IA)
  ai/
    client.js            SDK oficial de Anthropic, modelo por env, timeout, fallback de modelo
    extractItems.js      documento → ítems estructurados (structured outputs + zod)
    rerank.js            desempate acotado a candidatos validados
  matching/
    text.js              normalización, tokens, Levenshtein
    requestAttributes.js atributos del pedido (cantidad, unidad, A4/oficio, rayado, color…)
    engine.js            candidatos → ranking → reglas → validación → confianza
    constraints.js       incompatibilidades (fuente única)
    quantity.js          cantidad pedida vs unidades por paquete
  budget/
    budgetService.js     orquesta el pipeline; precios SIEMPRE desde catálogo
    pdf.js               PDF del presupuesto
  observability/logger.js  logs JSON por etapa (sin datos personales)
public/widget.html
scripts/sync-catalog.js  sincroniza catálogo (API Tiendanube o tienda pública)
scripts/eval-matching.js métricas sobre el dataset
test/                    node:test (sin dependencias extra)
```

### Pipeline

```
archivo(s) / texto pegado
 → fileReader (valida tipo real, memoria, nunca disco)
 → extracción: IA estructurada (texto/imagen/PDF) ── si falla → lineExtractor determinístico
 → por ítem: normalización + lexicón → concepto + atributos
 → candidatos: filtro por concepto + BM25 sobre nombres normalizados (≤ 30)
 → ranking determinístico (atributos, preferidos, stock, marca)
 → reglas comerciales (config/matchingRules.js)
 → constraints (descarta incompatibles)
 → confianza: muy alta / alta / media / baja
 → [opcional] IA desempata sólo los "media" con ≤5 candidatos ya válidos
 → cantidades: unidades pedidas ÷ unidades por paquete
 → precios y totales desde catálogo
```

### Elección de búsqueda (por qué no embeddings)

Catálogo de ~2.000 productos, nombres cortos tipo "LAPIZ COLOR X12 L.CARIOCA 4.0", vocabulario escolar argentino muy específico.

| Opción | Veredicto |
|---|---|
| Normalización + lexicón de conceptos | **Sí.** Es lo que evita "lápiz ↔ birome". Barato, auditable. |
| Índice invertido + BM25 | **Sí.** Ranking léxico rápido (<1 ms), sin dependencias. |
| Levenshtein acotado | **Sí**, sólo para corregir errores de tipeo contra el vocabulario del lexicón/catálogo. |
| Fuse.js | No: es fuzzy sobre strings completos; con nombres de catálogo genera falsos positivos y no aporta frente a BM25 + typo-fix. |
| Embeddings / búsqueda híbrida | No por ahora: costo e infraestructura extra; similitud semántica acerca justamente categorías vecinas (lápiz/lapicera, fibra/marcador) que queremos separar. Reevaluar si el catálogo supera ~20 k productos o si las métricas de cobertura lo piden. |
| Clasificación por categorías + atributos estructurados | **Sí**, vía lexicón (conceptos) y extractor de atributos. Es la defensa contra falsos positivos. |

### Catálogo

La tienda es **Tiendanube** (store id 854738). Fuentes posibles:

1. **API oficial** `https://api.tiendanube.com/2025-03/{store_id}/products` con `Authorization: Bearer <token>` y `User-Agent` obligatorio; 200 productos por página, rate limit 40/2 por segundo. Requiere que el dueño cree una app y obtenga el token. Es la opción recomendada a mediano plazo (incluye categorías, marcas, variantes, imágenes, `updated_at_min` para sync incremental).
2. **Tienda pública**: `GET /productos/page/N/?results_only=true` devuelve 12 productos por página con `data-variants` (product_id, variant id, SKU, precio, stock, disponibilidad, imagen). ~160 páginas para todo el catálogo. No requiere credenciales. Es la fuente que usamos **ya** para tener precios reales.
3. `catalog.json` (actual) queda como snapshot local / fallback.

Todas implementan la misma interfaz (`load() → Product[]`) y escriben un snapshot normalizado. El motor nunca sabe de dónde vino el catálogo.

### Carrito real

La tienda arma el carrito con `POST /comprar/` (`add_to_cart=<product_id>`, `variation[i]`, `quantity`) — es el formulario de cada página de producto. Ese endpoint depende de la cookie de sesión de `librerialerma.com.ar`, así que **no puede llamarse desde el iframe** (`onrender.com`, otro origen; cookies de terceros bloqueadas). La forma segura: el iframe envía por `postMessage` la lista `{productId, variantId, quantity}` a la página padre (que ya escucha `postMessage` para el alto del iframe), y un script en la página padre — mismo origen que la tienda — agrega los productos secuencialmente y redirige a `/carrito`. Requiere pegar un script en la página de Tiendanube (Fase 2) y probarlo en la tienda real.

## 12. Propuesta de producto y UX

- **Entrada**: tres pestañas — Subir archivo (drag & drop, múltiples fotos/páginas), Sacar foto (input `capture` en móvil), Pegar lista (textarea). "Escribí lo que necesitás" = la misma textarea.
- **Progreso real**: el backend emite etapas (leyendo → identificando → buscando → calculando) por streaming de eventos; nada de timers falsos.
- **Resultado**: total + cobertura arriba (sticky en móvil); grupos "Listos para comprar", "Revisá estos" (confianza media/baja, con alternativas), "Solo en sucursal", "No los tenemos". Cada fila: imagen, lo pedido, producto, marca, precio, cantidad editable (stepper), subtotal, link. Acciones: cambiar (alternativas: Recomendado / Más económico / Otra), quitar, buscar otro producto, agregar a mano. Totales recalculados al instante en el cliente y **revalidados en el backend** al exportar/compartir/carrito.
- **Modo Económico / Recomendado / Premium**: sólo se ofrece si ≥60 % de los ítems tienen ≥2 alternativas; si no, no se muestra.
- **Acciones de cierre**: Agregar al carrito (real, vía página padre), Enviar por WhatsApp, Descargar PDF (servidor, con id + QR + vigencia), Copiar link.
- **Edición del texto leído**: cada ítem muestra lo que la IA leyó; tocarlo permite corregir ("Carpeta N5" → "Carpeta N3") y se re-matchea sólo ese ítem sin volver a subir nada (`POST /api/match`).
- Errores en lenguaje natural con salida útil (reintentar, pegar el texto, WhatsApp).

## 13. Roadmap por fases

| Fase | Objetivo | Entregables | Criterio de salida |
|---|---|---|---|
| **0 — Hotfix** | Volver a estar online sin riesgo | Sintaxis, modelo por env, precios desde catálogo, regex, XSS, CORS, rate limit, errores amigables, timeouts | Producción presupuesta una lista real |
| **1 — Motor V2** | Matching determinístico confiable | Arquitectura modular, lexicón + reglas config, BM25, atributos, packs, constraints, confianza, IA con schema y fallback, sync de catálogo, dataset de regresión + métricas, logs | 100 % de los casos de regresión, 0 falsos positivos en el dataset, mismo contrato de API |
| **2 — UX V2** | Experiencia de ecommerce | Widget nuevo mobile-first, edición, alternativas, imágenes, pegar/cámara/multi-foto, progreso real, carrito real vía página padre, WhatsApp, PDF nuevo | Prueba en celular real; agregar al carrito verificado en la tienda |
| **3 — Datos** | Aprender de cada presupuesto | Presupuestos persistentes `/presupuesto/:id` (SQLite), eventos GA4, panel admin protegido, feedback de sustituciones | Panel con demanda no satisfecha |
| **4 — Escala** | Temporada alta | Sync programado, cola/concurrencia hacia IA, caché por hash de documento, alertas | Prueba de carga |

## 14. Quick wins (implementables ya)

1. Quitar las líneas de git y restaurar la ruta del PDF.
2. Modelo por variable de entorno.
3. Precio y subtotal recalculados desde catálogo.
4. Arreglar las 5 regex sin `\`, plural/tilde de birome/bolígrafo, cirílico, resaltador vs marcador.
5. Escapar HTML en el widget; "Sin stock" → "No disponible en catálogo".
6. CORS con lista de orígenes; rate limit al endpoint de IA.
7. Errores sin detalles internos; timeout de IA.
8. Excluir productos con precio ≤ $1 del presupuesto.
9. Sincronizar precios desde la tienda pública.

## 15. Bugs críticos a resolver antes de cualquier refactor

B1 (modelo), B2 (sintaxis), B3 (precios de IA), B5 (XSS), endpoint abierto a abuso. B4 (catálogo) se resuelve en Fase 1 con el sync, que no depende del refactor.
