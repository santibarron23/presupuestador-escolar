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

- [docs/AUDITORIA.md](docs/AUDITORIA.md): diagnóstico del sistema anterior.
- [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md): cómo funciona, cómo editar reglas, endpoints, variables de entorno.
- [docs/ROADMAP.md](docs/ROADMAP.md): fases.
