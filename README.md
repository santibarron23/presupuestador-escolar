# Presupuestador escolar — Librería Lerma

Las familias suben la foto, el PDF o el texto de la lista de útiles y obtienen un presupuesto con productos, precios y stock reales de [librerialerma.com.ar](https://librerialerma.com.ar/presupuesta-tu-lista-escolar/).

```bash
npm install
npm run sync-catalog   # catálogo actualizado desde la tienda (≈3 min)
npm start              # http://localhost:3001/widget
```

Sin `ANTHROPIC_API_KEY` funciona con listas de texto (extracción sin IA). Para fotos y PDFs escaneados hace falta la key.

| | |
|---|---|
| `npm test` | tests (sin IA real, sin costo) |
| `npm run eval` | métricas de matching sobre los datasets |
| `npm run try -- "2 cuadernos A4 rayados"` | probar el motor con un ítem |
| `npm run load-test` | prueba de carga local con la IA simulada (sin costo) |

El servidor sincroniza el catálogo solo cada 6 h (`CATALOG_SYNC_HOURS=0` lo desactiva, útil en desarrollo para no tocar `data/catalog.json`).

## Producción (Render → Environment)

| Variable | Para qué |
|---|---|
| `ANTHROPIC_API_KEY` | leer fotos y PDFs |
| `DATABASE_URL` | Postgres administrado (Neon / Supabase / Render). Opcional: sin ella, métricas en memoria y links autocontenidos |
| `DATABASE_SSL_NO_VERIFY=1` | sólo si el proveedor usa un certificado que Node no reconoce (pooler de Supabase) |
| `ADMIN_TOKEN` | activa el panel `/admin` (token largo y aleatorio) |
| `AI_MAX_CONCURRENCY` / `AI_MAX_QUEUE` | lecturas de IA simultáneas (8) y tamaño de la fila (30) para temporada alta |
| `SHARE_BASE_URL` | con el snippet instalado: `https://www.librerialerma.com.ar/presupuesta-tu-lista-escolar/?p=` para que los links abran en la tienda |

- [docs/AUDITORIA.md](docs/AUDITORIA.md): diagnóstico del sistema anterior.
- [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md): cómo funciona, cómo editar reglas, endpoints, variables de entorno.
- [docs/ROADMAP.md](docs/ROADMAP.md): fases.
