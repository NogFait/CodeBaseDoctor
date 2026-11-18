# Material para el portafolio

Imágenes del proyecto listas para usar en un portafolio, LinkedIn o la ficha del repositorio.
Se generan con scripts (no se editan a mano), así que se regeneran si cambia la interfaz.

| Archivo | Tamaño | Para qué |
| --- | --- | --- |
| `cover.png` | 3200 × 1800 (16:9, retina) | Portada del proyecto: tarjeta del portafolio, LinkedIn, presentaciones |
| `social-preview.png` | 1280 × 640 (< 1 MB) | Vista previa social del repo en GitHub |
| `architecture.png` | 3200 × 1800 (16:9, retina) | Diagrama de la arquitectura hexagonal, para el caso de estudio |
| `report-es.png` / `report-en.png` | 1640 × ~3370 | Reporte completo de `lukeed/clsx` (juez LLM real), en español e inglés |
| `entry-es.png` / `entry-en.png` | 1640 × 660 | Pantalla de ingreso con la URL escrita |
| `progress-es.png` | 1640 × 1040 | Progreso en vivo: las seis categorías en "pendiente" |
| `report-partial-es.png` | 1640 × ~2230 | Reporte parcial: una categoría no pudo puntuarse ("Reintentar") |
| `report-failed-es.png` | 1640 × 800 | Scan fallido con la cuota reembolsada |

Las capturas son de la aplicación real, no de datos de ejemplo. El reporte principal sale de un análisis
de `lukeed/clsx` hecho con un juez LLM de verdad (`openai/gpt-oss-120b` en el tier gratuito de Groq).
Las de **reporte parcial** y **scan fallido** son estados de error forzados con el juez `stub`
(por eso en el parcial Documentation dice `[stub verdict]`): no se puede provocar una falla del LLM a pedido
con un juez real.

## Subir el social preview a GitHub

GitHub no permite subirlo por API, así que es manual: **Settings → General → Social preview → Edit →
Upload an image** y elegir `social-preview.png`.

## Regenerar

Requiere Chromium de Playwright y red (las plantillas cargan la fuente Poppins de Google Fonts).

```bash
# 1. capturas reales de la SPA (necesita la api y la web levantadas)
WEB_URL=http://localhost:5173 node scripts/portfolio/capture-screenshots.mjs

# 1b. estados de error y progreso: hay que preparar el entorno (ver el encabezado del script)
#     partial -> worker con LLM_JUDGE=stub STUB_JUDGE_FAIL_CATEGORIES=architecture
#     failed  -> api SIN worker (el script marca el job como `failed` en Postgres)
STATE=partial WEB_URL=http://localhost:5173 node scripts/portfolio/capture-states.mjs
STATE=failed  WEB_URL=http://localhost:5173 node scripts/portfolio/capture-states.mjs

# 2. portada, social preview y diagrama (HTML -> PNG)
node scripts/portfolio/render-images.mjs            # las tres
node scripts/portfolio/render-images.mjs cover      # solo una: cover | social | architecture
```

La portada y el social preview usan `report-es.png`, así que hay que correr el paso 1 antes que el 2.
Las plantillas están en `scripts/portfolio/*.html`.
