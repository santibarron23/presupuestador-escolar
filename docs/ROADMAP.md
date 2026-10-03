# Roadmap

## Fase 0 — Hotfix ✅ (rama `fase-0-hotfix`)
Producción caída (modelo retirado + `server.js` con comandos de git pegados). Cambio mínimo y desplegable solo: modelo por env, precios desde catálogo, regex arregladas, XSS, CORS, rate limit, errores amigables.

## Fase 1 — Motor V2 ✅ (rama `fase-1-motor-v2`)
- Arquitectura modular (`src/`), mismo contrato de API: el widget actual funciona sin cambios grandes.
- Catálogo sincronizado desde la tienda (precios, stock, variantes, imágenes, URL) + recarga en caliente; API oficial lista para cuando haya token.
- Lexicón + reglas comerciales en configuración; matching determinístico con restricciones, packs, variantes y confianza.
- IA: SDK oficial, modelo por env, modelo alternativo, salida estructurada validada con zod, timeouts; ya no recibe el catálogo.
- Fallback sin IA para listas de texto; desempate por IA acotado a candidatos válidos.
- Seguridad: archivos en memoria, tipo por contenido, CORS, `frame-ancestors`, rate limit, sin detalles internos.
- Tests (29) + datasets de regresión (127) y holdout (50) + métricas. Logs JSON por etapa.
- Widget actual: fotos achicadas antes de subir, "Revisá", notas de paquetes, motivos de no encontrados.

**Pendiente de verificar con credenciales reales:** una corrida con `ANTHROPIC_API_KEY` sobre fotos reales (`npm test` usa una IA simulada).

## Fase 2 — Experiencia ✅ (salvo el paso manual del carrito)
- Widget nuevo mobile-first con la identidad de la tienda (verde #0D6E45, Montserrat, botones píldora): Archivo / Foto (`capture`) / Pegar; varias fotos por lista; fotos achicadas en el navegador.
- Progreso real por etapas (`/api/presupuestar?stream=1`, Server-Sent Events): leyendo → identificando → buscando → calculando. Sin timers falsos.
- Resultados editables: cantidad, "Está bien", cambiar por alternativa (Más económico / Otra opción) o buscar en la tienda, quitar con deshacer, corregir el texto leído y re-buscar sin IA, agregar a mano; imágenes reales; filtro por grado si la lista trae varios; totales instantáneos.
- Secciones: "Revisá estos", "En tu presupuesto", "Sólo en la sucursal", "Para consultar".
- WhatsApp (total, cantidad, pendientes, link), PDF nuevo (logo, N°, vigencia, pendientes), eventos de analítica vía `postMessage`.
- Versión anterior disponible en `/widget/v1` para volver atrás.

**Paso manual pendiente — carrito real:** pegar `docs/tiendanube-snippet.html` en la página de Tiendanube (reemplaza el iframe actual). Ese script agrega los productos al carrito con el mismo pedido que el botón de cada producto (`POST /comprar/`) y abre el carrito. Hasta que esté pegado, "Agregar al carrito" muestra la lista de productos con links (como antes). Probarlo con 2–3 productos después de pegarlo.

**Queda para Fase 3:** QR y link al presupuesto (necesitan persistencia); modos Económico / Recomendado / Premium (sólo si ≥60 % de los ítems tienen alternativas reales).

## Fase 3 — Datos y negocio ✅
- Presupuestos compartibles: botón **Guardar o compartir el link**, link en el mensaje de WhatsApp y **QR en el PDF**. Se guarda sólo el texto de cada ítem, producto, variante y cantidad (nunca el archivo). Al abrirlo se recalculan precios y stock; si un producto ya no está, se sugiere otro.
  - Con `DATABASE_URL` (Postgres): id corto de 8 caracteres, vence a los `BUDGET_SHARE_DAYS` (90).
  - Sin base: el presupuesto viaja comprimido en el link (funciona igual aunque Render reinicie; el link es más largo y el PDF no lleva QR).
- Métricas propias anónimas y agregadas por día (sin cookies, IDs ni IP): presupuestos, cobertura, estados, categorías, carrito, WhatsApp, PDF, links. GA4 sigue recibiendo todos los eventos vía el snippet de la tienda.
- Panel **/admin** (token `ADMIN_TOKEN`): KPIs, embudo de conversión, presupuestos por día, **demanda no satisfecha** con CSV (lista de compras para el catálogo), categorías más pedidas y tasa de acierto, sustituciones propuesto → elegido.
- Feedback de sustituciones: sólo IDs de catálogo y categoría; sirven para ajustar `src/config/matchingRules.js` a mano (nunca se aplican solas).
- Arreglado: una elección manual sobre un ítem "Para consultar" se ignoraba; la lista "Para consultar" de WhatsApp/PDF repetía la cantidad.

## Fase 4 — Temporada alta ✅
- **Catálogo al día sin redeploy**: el servidor se sincroniza solo cada `CATALOG_SYNC_HOURS` (6 h) y enseguida al arrancar si el snapshot es viejo. Un sync con menos de 100 productos o que cae más de 30 % se descarta y se sigue usando el catálogo anterior. 3 fallos seguidos → log de error; `/api/health` pasa a `degraded` si el catálogo tiene más de dos ciclos.
- GitHub Action semanal (`.github/workflows/sync-catalog.yml`, también manual): actualiza `data/catalog.json` (el snapshot con el que arranca Render), corre los tests y commitea sólo si pasan. Si falla, GitHub avisa por mail.
- Botón **Sincronizar catálogo ahora** en `/admin` (después de cargar productos nuevos en la tienda).
- **Fila de IA**: como mucho `AI_MAX_CONCURRENCY` (8) lecturas a la vez, fila de `AI_MAX_QUEUE` (30), espera máxima `AI_QUEUE_TIMEOUT_MS` (60 s). La familia ve su lugar real en la fila. Fila llena: con texto pegado se lee sin IA; con fotos, mensaje claro para reintentar (503), nunca una conexión colgada. El desempate por IA se saltea si hay fila.
- **Caché por documento** (hash del contenido, sólo en memoria, 24 h): la misma lista del colegio se lee una vez; si llega dos veces a la vez, la segunda espera la primera lectura.
- Métricas de operación en `/admin` y `/api/health`: lecturas de IA, aciertos de caché, tokens promedio, tiempo promedio y p50/p95, fila actual, estado del sync.
- Prueba de carga: `npm run load-test` (IA simulada, sin costo).

### Resultados de la prueba de carga (IA simulada a 6 s por lectura, una sola instancia)
| Escenario | Resultado |
|---|---|
| 60 familias suben una foto distinta **en el mismo segundo** | 38 atendidas (p50 12 s, p95 32 s); 22 reciben al instante "probá en un minuto". Con 4 lecturas a la vez el p95 era 68 s: por eso el default es 8 |
| 40 familias suben el mismo PDF del colegio | **1 sola lectura de IA**; todas en 6–9 s |
| 500 ediciones (re-match de 15 ítems, sin IA), 50 usuarios a la vez | 114 pedidos/s, p95 0,6 s, sin errores |

Para más capacidad: subir `AI_MAX_CONCURRENCY` (si el límite de la cuenta de Anthropic lo permite) o pasar Render a un plan pago (sin "dormir" y con más CPU para el matching).
