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

## Fase 2 — Experiencia (siguiente)
1. Widget nuevo mobile-first: Subir / Sacar foto (`capture`) / Pegar lista; varias fotos por lista.
2. Progreso real por etapas (respuesta en streaming desde `createBudget`, que ya mide etapas).
3. Resultados editables: cantidad, cambiar por alternativa (Recomendado / Más económico / Otra), quitar, buscar y agregar, corregir el texto leído (`/api/match`); imágenes reales; totales instantáneos y revalidados (`/api/presupuesto/validar`).
4. **Carrito real**: el carrito de Tiendanube vive en la cookie de `librerialerma.com.ar`, así que el iframe no puede escribirlo. El widget manda por `postMessage` la lista `{productId, variantId, cantidad}` a la página padre; un script pegado en la página de Tiendanube (mismo origen) llama a `POST /comprar/` (el mismo formulario de cada producto: `add_to_cart`, `variation[]`, `quantity`) uno por uno y redirige al carrito. **Requiere probarlo en la tienda real** antes de publicarlo.
5. WhatsApp: mensaje corto con total, cantidad de artículos, pendientes y link.
6. PDF nuevo (logo ya incluido, id, vigencia) + QR al presupuesto (con Fase 3).
7. Modos Económico / Recomendado / Premium sólo si ≥60 % de los ítems tienen alternativas reales.

## Fase 3 — Datos y negocio
- Presupuestos persistentes `/presupuesto/:id` (sólo ítems, cantidades y productos; nunca el documento). Render no tiene disco persistente en el plan gratuito: usar Postgres administrado (Render Postgres o Supabase).
- Eventos (GA4 del sitio padre vía `postMessage`, sin trackers nuevos): `budget_started`, `file_uploaded`, `budget_completed`, `match_changed`, `product_removed`, `alternative_selected`, `pdf_downloaded`, `whatsapp_clicked`, `add_to_cart_clicked`, `budget_shared`.
- Panel admin protegido: presupuestos, completados, cobertura media, más pedidos, **no encontrados** ("120 familias pidieron X"), sustituciones manuales, valor medio.
- Feedback loop: cada reemplazo manual se guarda anónimo (pedido normalizado → producto del motor → producto elegido) para proponer reglas; nunca se aplican solas.

## Fase 4 — Temporada alta
- Sync del catálogo programado (cron diario) y alerta si falla.
- Concurrencia acotada hacia la IA + caché por hash del documento.
- Prueba de carga; monitoreo de latencia, errores y costo por presupuesto.
