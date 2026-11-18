# Arquitectura V2

Un solo servicio Node/Express (CommonJS, sin build). La lógica de negocio editable vive en `src/config/`.

```
server.js                    entrada (carga catálogo, levanta HTTP)
src/
  app.js                     rutas, seguridad, errores
  config/
    index.js                 variables de entorno
    lexicon.js               lenguaje escolar → conceptos, marcas, envases, tipeos   ← editar acá
    matchingRules.js         reglas comerciales: preferidos, excluidos, sucursal       ← editar acá
  catalog/
    catalogStore.js          catálogo en memoria, índice BM25, recarga en caliente
    providers/               storefront (tienda pública) · tiendanubeApi · jsonFile
  parsing/
    fileReader.js            tipo real por magic bytes, PDF/DOCX/TXT/imagen, todo en memoria
    lineExtractor.js         extracción sin IA (fallback)
  ai/
    client.js                SDK de Anthropic, modelo por env, fallback de modelo, salida estructurada + zod
    extractItems.js          documento → ítems (la IA no ve el catálogo)
    rerank.js                desempate de ítems dudosos entre candidatos ya válidos
  matching/
    text.js                  normalización, tokens, singular, Levenshtein
    concepts.js              clasificación por lexicón
    attributes.js            formato, rayado, hojas, acabado, punta, color, marca, envase…
    requestParser.js         pedido → estructura (cantidad, concepto, atributos)
    constraints.js           incompatibilidades (fuente única)
    quantity.js              cantidad pedida vs. paquetes, elección de variante
    engine.js                candidatos → ranking → reglas → confianza → alternativas
  budget/
    budgetService.js         orquesta el pipeline; precios SIEMPRE del catálogo
    pdf.js                   PDF del presupuesto
  observability/logger.js    logs JSON por etapa, sin datos personales
public/widget.html           widget embebido en la tienda
data/catalog.json            snapshot del catálogo (generado por scripts/sync-catalog.js)
scripts/                     sync-catalog · eval-matching · try-match
test/                        node:test + datasets (regresión y holdout)
```

## Pipeline

```
archivo(s) / texto pegado
 → fileReader: tipo real (no confía en la extensión), en memoria, nunca a disco
 → extracción: IA con schema (texto/foto/PDF)        ── si falla y es texto → lineExtractor (sin IA)
 → por ítem: normalización + tipeos → concepto (lexicón) + atributos
 → candidatos: productos del mismo concepto (los demás no existen para ese pedido)
 → restricciones: A4≠oficio, rayado≠cuadriculado, zurdo, punta, "con folios", sin stock…
 → ranking: BM25 + atributos + reglas comerciales + marca + paquete justo + precio (desempate)
 → confianza: muy alta / alta / media / baja
 → IA desempata sólo "media" (≤ AI_RERANK_MAX_ITEMS), eligiendo entre candidatos válidos o "ninguno"
 → variante (color, tamaño, número) y paquetes (20 folios → 2 × x10)
 → precio y subtotal desde catálogo
```

### Estados de un ítem

| status | confianza | qué significa | en el total |
|---|---|---|---|
| `matched` | muy alta / alta | elegido automáticamente | sí |
| `review` | media | elegido, con alternativas; conviene revisar | sí |
| `suggested` | baja | no elegido: hay sugerencias, decide la familia | no |
| `in_store` | — | se consigue sólo en sucursal (p.ej. resmas blancas) | no |
| `out_of_stock` | — | existe pero sin stock online | no |
| `not_sold` | — | no lo vendemos (higiene, libros, deportes…) | no |
| `not_found` | — | no hay producto compatible | no |

## Decisiones

- **La IA lee, el código decide.** La IA ya no recibe el catálogo ni reglas: sólo extrae ítems con un schema validado. El matching es determinístico, reproducible y testeable. Un prompt de ~5–8 k tokens + 300 productos pasó a ~600 tokens de instrucciones + la lista.
- **Concepto antes que similitud.** Un pedido sólo compite contra productos de su concepto. Es la principal defensa contra falsos positivos ("lápiz" nunca puede terminar en birome).
- **BM25 + lexicón, sin embeddings.** Con ~1.700 productos de nombres cortos, la búsqueda léxica con lexicón es más precisa, gratis y auditable (0,3 ms/ítem). Embeddings acercan justamente lo que hay que separar (lápiz/lapicera, fibra/marcador).
- **Confianza honesta.** Si hay una palabra desconocida delante del concepto ("cortante de masa"), si la marca pedida no está, o si no sabemos cuántas hojas trae un paquete, el ítem no se auto-selecciona o queda para revisar.
- **Precios siempre del catálogo**, también en `/api/presupuesto/validar` y el PDF.
- **Fallbacks por etapa**: modelo alternativo (`AI_FALLBACK_MODEL`) ante saturación/timeout/rechazo; extracción sin IA para texto; desempate opcional; catálogo legacy si falta el snapshot.

## Cómo editar reglas

- **Sinónimo o palabra nueva** ("voligoma" = adhesivo): `src/config/lexicon.js`, patrón `req` del concepto.
- **Producto preferido** para un pedido: `src/config/matchingRules.js` → `prefer: [{ sku }]`. Si el SKU no es único, agregar `name: /regex/`.
- **Excluir productos** para un pedido: `exclude: [/regex/]` en la regla. Para una característica que sólo va si se pide (zurdo, Oxford): `EXCLUDE_UNLESS_REQUESTED`.
- **Sólo en sucursal**: regla con `inStore`.
- Después de cambiar: `npm test` y `npm run eval`. Agregá el caso al dataset (`test/fixtures/matching-cases.json`).
- Probar a mano: `npm run try -- "2 cuadernos A4 rayados"`.

## Catálogo

`npm run sync-catalog` escribe `data/catalog.json` (escritura atómica; si trae menos de 100 productos no pisa el anterior).
El servidor lo recarga solo (cada `CATALOG_RELOAD_MS`).

- Sin credenciales usa la **tienda pública** (`/productos/page/N/?results_only=true`, ~160 páginas, ~3 min): SKU, precio, stock, variantes, imágenes, URL.
- Con `TIENDANUBE_ACCESS_TOKEN` usa la **API oficial** (`api.tiendanube.com/2025-03/{store_id}`): agrega categorías y marca. El token se obtiene creando una app para la tienda en el panel de socios de Tiendanube.

## Endpoints

| Método | Ruta | Uso |
|---|---|---|
| POST | `/api/presupuestar` | multipart: `lista` (hasta 5 archivos) o `texto` (pegado). Límites por IP, horario y globales (ver abajo). |
| POST | `/api/match` | `{ lines: [{ text, quantity, productId?, variantId?, packs? }] }` re-matchea sin IA (edición, reemplazo manual). |
| GET | `/api/productos/buscar?q=` | búsqueda para reemplazar/agregar a mano. |
| POST | `/api/presupuesto/validar` | `{ lines: [{ productId, variantId, packs }] }` → precios del catálogo. |
| POST | `/api/presupuesto-pdf` | `{ budgetId, lines, pending }` o formato v1 `{ items }` → PDF. |
| GET | `/api/catalogo` | campos públicos (compatibilidad). |
| GET | `/api/health` | estado, catálogo, IA. |
| GET | `/widget` | widget (sólo embebible desde la tienda). |

## Protección contra abusos

Código en `src/security/`. Pensada para que una familia nunca la note: una conexión puede ser compartida
(wifi de un colegio, datos móviles con IP compartida), por eso los límites por IP son holgados y el freno
fuerte al costo es el tope global.

- **IP real**: el pedido pasa por Cloudflare y Render. Se usa `CF-Connecting-IP` (Cloudflare la pisa si viene
  falsa); si falta, `trust proxy = 2`. Antes (`trust proxy = 1`) el límite se aplicaba a la IP de un nodo de
  Cloudflare: compartido entre miles de personas y fácil de esquivar. IPv6 se agrupa por /64.
- **Presupuestos por IP**: 10 cada 10 min, 30 por hora, 80 por día (el día arranca a medianoche de Argentina).
- **Horario nocturno** (0 a 7 h): 8 por hora por IP.
- **Tope global de IA**: 300 lecturas por hora y 2000 por día sumando todas las IPs. Superado: el texto pegado
  sigue funcionando sin IA; las fotos reciben un mensaje claro (pegá el texto o WhatsApp). La caché no cuenta.
- **PDF, links, eventos y panel** con sus propios límites. **Memoria**: pedidos de más de 25 MB se rechazan
  antes de leerlos y como mucho 20 pedidos con archivos a la vez.
- Los contadores de hora/día viven en Postgres (`rate_counters`), así un reinicio no "perdona" a nadie; la IP
  nunca se guarda en claro (HMAC con secreto del servidor). Si la base falla se cuenta en memoria.
- Cada pedido frenado se cuenta en `/admin` → "Protección contra abusos", con el motivo.
- Respuesta al superar un límite: `429` + `Retry-After` + mensaje que dice cuánto esperar.

### Topes de consumo (costo de IA, CPU, base de datos)

- **Tokens de IA por día**: 8 millones (entrada + salida, sumando todo el sitio). Es el tope de costo real: se
  revisa antes de cada lectura y se suma lo que la API informa que se usó. Ajustarlo mirando "Tokens promedio por
  lectura" en `/admin`. Superado: igual que el tope de lecturas (texto sin IA, fotos con mensaje).
- **PDF**: como mucho 10 páginas por archivo y 12 entre todos (cada página escaneada se cobra en la IA). Un PDF que
  no se puede abrir no se manda "a ciegas" a la IA. El texto extraído de PDF/Word se limita a 40.000 caracteres.
- **Lector de PDF**: pdf.js 4 (Mozilla) con `isEvalSupported: false` (nunca ejecuta código del PDF), sin fuentes y
  con tiempo máximo. Reemplaza a pdf-parse 1.x, que traía un pdf.js de 2017.
- **Word**: antes de abrirlo se lee el índice del zip; si declara más de 40 MB descomprimido (bomba zip), se rechaza.
- **CPU**: `/api/match` acepta hasta 40 líneas (el widget manda de a una); abrir un link compartido tiene su propio
  límite (20 por minuto por IP). Timeouts del servidor contra conexiones lentas (slowloris).
- **Base de datos**: como mucho 3000 links nuevos por día en todo el sitio; la tabla de demanda se poda sola (máx.
  20.000 filas, 40 por presupuesto) y los contadores vencidos se borran.

### Encabezados de seguridad

`Content-Security-Policy` estricta en el widget y el panel (sin scripts de otros dominios, `connect-src 'self'`:
aunque se colara texto malicioso no podría mandar datos afuera; sólo embebible desde la tienda),
`Strict-Transport-Security`, `Permissions-Policy`, `X-Content-Type-Options`, `Referrer-Policy` y
`Cross-Origin-Opener-Policy` en el panel. Dependencias sin vulnerabilidades conocidas (`npm audit`), multer 2.

## Variables de entorno

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | obligatoria para leer fotos/PDF escaneados |
| `AI_MODEL` | `claude-opus-5-5` | modelo principal |
| `AI_FALLBACK_MODEL` | `claude-sonnet-5-5` | si el principal falla o está saturado |
| `AI_EFFORT` | `low` | extracción simple: menos latencia y costo |
| `AI_TIMEOUT_MS` | `60000` | por llamada |
| `AI_RERANK_MAX_ITEMS` | `15` | 0 desactiva el desempate por IA |
| `AI_DISABLED` | — | `1` = sin IA (sólo texto) |
| `ALLOWED_ORIGINS` | tienda + render | CORS y `frame-ancestors` |
| `RATE_LIMIT_PER_10MIN` / `_PER_HOUR` / `_PER_DAY` | `10` / `30` / `80` | presupuestos por IP (ver "Protección contra abusos") |
| `RATE_LIMIT_NIGHT_PER_HOUR` | `8` | presupuestos por IP por hora entre `NIGHT_START_HOUR` (0) y `NIGHT_END_HOUR` (7), hora argentina |
| `AI_GLOBAL_PER_HOUR` / `AI_GLOBAL_PER_DAY` | `300` / `2000` | tope de lecturas con IA de todo el sitio (costo) |
| `AI_GLOBAL_TOKENS_PER_DAY` | `8000000` | tope de tokens de IA por día (entrada + salida) |
| `MAX_PDF_PAGES` / `MAX_TOTAL_PDF_PAGES` | `10` / `12` | páginas de PDF por archivo / por pedido |
| `MAX_DOCUMENT_CHARS` · `MAX_DOCX_UNCOMPRESSED_MB` | `40000` · `40` | texto extraído de PDF/Word · tamaño descomprimido de un Word |
| `MAX_MATCH_LINES` · `SHARE_OPENS_PER_MIN` | `40` · `20` | líneas por re-match · aperturas de links por IP |
| `SHARES_GLOBAL_PER_DAY` | `3000` | links nuevos por día en todo el sitio |
| `SHARES_PER_10MIN` / `SHARES_PER_DAY` | `30` / `150` | links compartidos por IP |
| `PDF_PER_10MIN` / `PDF_PER_DAY` | `20` / `150` | PDF por IP |
| `EVENTS_PER_MIN` · `ADMIN_PER_10MIN` | `60` · `20` | eventos del widget · intentos en el panel |
| `MAX_REQUEST_MB` · `MAX_INFLIGHT_UPLOADS` | `25` · `20` | tamaño total de un pedido · pedidos con archivos a la vez |
| `TRUST_PROXY_HOPS` | `2` | Cloudflare + Render (sólo si falta `CF-Connecting-IP`) |
| `QUOTA_SECRET` | derivado de `ADMIN_TOKEN` | secreto para hashear IPs en los contadores |
| `CATALOG_PATH` | `data/catalog.json` | |
| `CATALOG_MIN_PRICE` | `2` | productos a $1 no se presupuestan |
| `TIENDANUBE_ACCESS_TOKEN` | — | habilita la API oficial en el sync |
| `STORE_WHATSAPP` | — | para la Fase 2 |

## Métricas actuales (`npm run eval`)

| Dataset | Casos | Precisión | Cobertura | Falsos positivos | A revisar |
|---|---|---|---|---|---|
| Regresión (reglas del sistema anterior + trampas) | 127 | 100 % | 100 % | 0 % | 18,9 % |
| Holdout — primera corrida, sin ajustar | 50 | 100 % | 92,7 % | 0 % | 48 % |
| Holdout — después de corregir los 3 fallos | 50 | 100 % | 100 % | 0 % | 48 % |

El dataset de regresión se usó para ajustar el motor, así que su 100 % es optimista. La primera corrida del holdout es la medición honesta. El 48 % "a revisar" del holdout es la siguiente palanca: ítems bien categorizados pero con varias opciones válidas, donde el desempate por IA y las alternativas de la UI (Fase 2) hacen el trabajo.
