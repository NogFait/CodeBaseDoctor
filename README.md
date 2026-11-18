<p align="center">
  <img src="docs/img/logo.png" alt="CodeBase Doctor IA" width="150">
</p>

<h1 align="center">CodeBase Doctor IA</h1>

<p align="center">
  <strong>Pasale la URL de un repositorio público de GitHub.<br>
  Te devuelve un puntaje de 0 a 100 en seis dimensiones de ingeniería — cada una con una explicación escrita y una etiqueta de confianza.</strong>
</p>

<p align="center">
  <a href="https://github.com/NogFait/CodeBaseDoctor/actions/workflows/ci.yml"><img src="https://github.com/NogFait/CodeBaseDoctor/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licencia-MIT-green?style=flat-square" alt="Licencia MIT"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/NestJS-E0234E?style=flat-square&logo=nestjs&logoColor=white" alt="NestJS">
  <img src="https://img.shields.io/badge/React-20232A?style=flat-square&logo=react&logoColor=61DAFB" alt="React">
  <img src="https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white" alt="Vite">
  <img src="https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white" alt="Tailwind CSS">
  <img src="https://img.shields.io/badge/Prisma-2D3748?style=flat-square&logo=prisma&logoColor=white" alt="Prisma">
  <img src="https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Redis-FF4438?style=flat-square&logo=redis&logoColor=white" alt="Redis">
  <img src="https://img.shields.io/badge/Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white" alt="Vitest">
  <img src="https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/pnpm-F69220?style=flat-square&logo=pnpm&logoColor=white" alt="pnpm">
</p>

![CodeBase Doctor IA — Analiza · Diagnostica · Mejora](docs/img/hero.png)

---

## Demo

![Demo: se pega la URL de un repo, el progreso por categoría se actualiza en vivo y llega el reporte](docs/img/demo.gif)

Grabado en local analizando [`lukeed/clsx`](https://github.com/lukeed/clsx): se pega la URL, el progreso por categoría se actualiza en vivo y llega el reporte de seis dimensiones, con el selector ES / EN. Architecture y Documentation las juzgó un LLM real (`openai/gpt-oss-120b` en el tier gratuito de Groq); el resto son análisis deterministas (Semgrep y OSV-Scanner reales, más heurísticas).

> **Es un análisis real, pero grabado:** no hay una instancia pública porque el worker necesita acceso a Docker para aislar cada repo y ejecutar el scanner. Para probarlo vos, seguí la [puesta en marcha](#puesta-en-marcha-desarrollo-local) — con el juez `stub` no hace falta ninguna key.

---

## Qué hace

CodeBase Doctor IA hace un shallow-clone de un repo público de GitHub dentro de un sandbox descartable y aislado de red, y corre seis analizadores independientes sobre él:

| Dimensión | Cómo se puntúa | Etiqueta de confianza | Peso |
| --- | --- | --- | --- |
| **Architecture** | Juez LLM (`LLMJudgePort`) sobre la estructura y el layering del repo | `judged` | 1.0 |
| **Security** | **Semgrep** + **OSV-Scanner** reales, ejecutados offline dentro del contenedor `cbd-scanner` | `measured` | 1.0 |
| **Testing** | Heurísticas deterministas — archivos de test por archivo fuente (satura en 0.5; reconoce JS/TS, Python, Go, Ruby, Java/Kotlin/C#, PHP y carpetas `test/`), más config de CI. Mide presencia de tests, no cobertura | `estimated` | 1.0 |
| **Maintainability** | Heurística determinista — proporción de archivos fuente sobredimensionados | `measured` | 1.0 |
| **Performance** | Escaneo estático de patrones heurísticos | `estimated` | **0.5** |
| **Documentation** | Pre-chequeo de presencia de README que alimenta a un juez LLM | `judged` | 1.0 |

El **puntaje compuesto** es la media ponderada de las categorías que efectivamente produjeron un puntaje, cada una ponderada por su cap. Performance está deliberadamente capado en `0.5` — la UI lo muestra como *"Low confidence — static estimate"* para que una señal débil nunca domine el número principal.

Un scan necesita que **al menos 4 de 6** categorías puntúen. En ese umbral o por encima, el resultado se persiste como `complete` (6/6) o `partial` (4–5/6) y se conserva la unidad de cuota diaria del usuario. Por debajo, el job se marca `failed` y **la unidad de cuota se reintegra**.

El sandbox **nunca ejecuta código provisto por el repositorio** — no corre ningún paso de `install`, `build` ni `test`. La ingesta tiene topes duros (~500 MB / 50k archivos, timeout de clone de 120 s, timeout de scan de 300 s) y es auditable por scan.

### Ejemplo

```bash
curl -s -XPOST localhost:3000/analyses \
  -H 'content-type: application/json' \
  -d '{"repoUrl":"https://github.com/tj/commander.js","forceRescan":false}'
# -> 202 { "jobId": "…", "status": "queued", "commitSha": "…", "pollAfterMs": 2000, "quota": { … } }

curl -s localhost:3000/analyses/<jobId>
# -> 202 mientras analiza (progreso por categoría) … luego 200 con el reporte completo de seis puntajes
```

---

## Capturas

La SPA tiene cuatro estados: ingreso de URL → progreso en vivo por categoría → reporte → re-scan. Son capturas de la aplicación real (se regeneran con `scripts/portfolio/`, ver [`docs/img/portfolio`](docs/img/portfolio/README.md)).

| | |
| --- | --- |
| ![Ingreso de URL](docs/img/portfolio/entry-es.png) | **Ingreso de URL** — pegás una URL pública de GitHub. |
| ![Progreso en vivo por categoría](docs/img/portfolio/progress-es.png) | **Progreso en vivo por categoría** — el cliente hace polling a `GET /analyses/:id`; cada una de las seis categorías pasa por `pendiente → en curso → puntuada`. |
| ![Reporte parcial](docs/img/portfolio/report-partial-es.png) | **Reporte parcial** — una categoría no se pudo puntuar (≥ 4 de 6 igual lo lograron). La tarjeta muestra "No pudo evaluarse" con un botón "Reintentar"; el compuesto se calcula con las que sí puntuaron. *Capturado con el juez `stub` forzado a fallar en Architecture, por eso Documentation dice `[stub verdict]`.* |
| ![Scan fallido — cuota reembolsada](docs/img/portfolio/report-failed-es.png) | **Scan fallido** — menos de 4 categorías puntuaron, o un timeout de clone/scan. El job queda `failed` y la unidad de cuota diaria se reembolsa. |

### Reporte completo, en español e inglés

<p align="center">
  <img src="docs/img/portfolio/report-es.png" alt="Reporte completo en español" width="48%">
  &nbsp;
  <img src="docs/img/portfolio/report-en.png" alt="Reporte completo en inglés" width="48%">
</p>

Seis tarjetas con puntaje compuesto, etiquetas de confianza (`measured` / `estimated` / `judged`), cuota diaria restante y "Volver a analizar" / "Analizar otro repo". Es el análisis de [`lukeed/clsx`](https://github.com/lukeed/clsx) con un juez LLM real (`openai/gpt-oss-120b`, tier gratuito de Groq): los rationales de Architecture y Documentation los escribe el modelo y por ahora salen en inglés (ver roadmap).

---

## Arquitectura

Monorepo con pnpm workspaces, hexagonal (ports-and-adapters). Dos procesos NestJS comparten una librería de dominio; una SPA de React habla únicamente con el proceso HTTP.

![Arquitectura hexagonal: SPA, procesos NestJS, núcleo con puertos y adaptadores](docs/img/portfolio/architecture.png)

El mismo diagrama con más detalle, en Mermaid:

```mermaid
flowchart TD
    User([Desarrollador])

    subgraph client [Navegador]
        SPA["apps/web — SPA React 19 + Vite<br/>ingreso de URL → progreso → reporte → re-scan"]
    end

    subgraph apiproc [apps/api — proceso HTTP NestJS]
        API["AnalysesController<br/>POST /analyses · GET /analyses/:id<br/>RFC 9457 application/problem+json"]
        RL["HeadCallRateLimiterPort"]
    end

    subgraph workerproc [apps/worker — proceso headless]
        WK["AnalysisProcessor (consumidor BullMQ)<br/>StaleJobWatchdogService"]
    end

    subgraph domain [libs/analysis — núcleo hexagonal]
        SVC["RepoAnalysisService<br/>resolve → cache → cuota → analizar → agregar → persistir / reintegrar"]
        RS["RepoSourcePort"]
        CA["CategoryAnalyzer ×6"]
        LJ["LLMJudgePort"]
        SR["ScoreRepositoryPort"]
        UQ["UsageQuotaPort"]
    end

    subgraph adapters [Adaptadores]
        CLONE["libs/repo-source — ShallowCloneAdapter (dockerode)<br/>cbd-fetcher → cbd-scanner, aislado de red"]
        ANALYZERS["libs/analyzers — 6 CategoryAnalyzers<br/>Security: Semgrep + OSV-Scanner<br/>Testing / Maintainability / Performance: heurísticas<br/>Architecture / Documentation: juez LLM"]
        JUDGE["libs/llm — AnthropicJudgeAdapter (claude-sonnet-5)<br/>o StubJudgeAdapter (offline, gratis)"]
        PRISMA["libs/persistence — PrismaScoreRepository"]
        QUOTA["DailyFreeTierAdapter"]
        RLA["RedisHeadCallRateLimiterAdapter"]
    end

    subgraph infra [Infraestructura]
        REDIS[("Redis<br/>cola BullMQ + contadores de ventana fija")]
        PG[("Postgres<br/>cache de RepoScan · jobs · cuota")]
    end

    User -->|URL de repo público de GitHub| SPA
    SPA <-->|JSON por HTTP + polling| API

    API --> RL --> RLA --> REDIS
    API -->|encola job| REDIS
    API -->|lookup de cache + peek de cuota| PRISMA
    REDIS -->|desencola| WK --> SVC

    SVC --> RS --> CLONE
    SVC --> CA --> ANALYZERS
    SVC --> LJ --> JUDGE
    SVC --> SR --> PRISMA --> PG
    SVC --> UQ --> QUOTA --> REDIS

    ANALYZERS -. corre dentro de .-> CLONE
```

`RepoAnalysisService` es el núcleo hexagonal: nunca toca git, Docker, un SDK de LLM ni SQL directamente — sus únicas aristas salientes son los ports de arriba.

### Ciclo de vida de un request

1. **`POST /analyses`** → `resolve(repoUrl)` — parsing puro y barato de la URL. Una URL malformada tira `InvalidRepoUrlError` → `400`.
2. **Chequeo de rate-limit** — `HeadCallRateLimiterPort.checkAndRecord(actorId)`, una compuerta de ventana fija sobre cuán seguido un actor puede disparar el paso costoso de lookup del repo. Por encima del límite → `429 /errors/rate-limited` (un tipo de error distinto del de cuota).
3. **`head(ref)`** — levanta el contenedor `cbd-fetcher`, corre `git ls-remote`, resuelve el commit SHA actual. Un repo privado o inexistente tira `RepoNotAccessibleError` (los dos casos son deliberadamente indistinguibles) → `422`.
4. **Chequeo de cache** — `findCached({ repoUrl, commitSha, engineVersion })`. Un hit devuelve el reporte cacheado de inmediato (`200`, `cached: true`) — **no consume cuota y no hace trabajo**. Se saltea por completo cuando `forceRescan: true`.
5. **Consumo de cuota** — en un cache miss, `UsageQuotaPort.consume(actorId, reservationId)` reserva una unidad diaria *antes* de que exista fila de job. Por encima del límite diario → `429 /errors/quota-exceeded` (con `Retry-After`).
6. **Encolado** — crea la fila `analysis_job`, empuja un job de BullMQ a Redis, adjunta el id del job de Bull, devuelve `202 { jobId }`.
7. **Worker** — `AnalysisProcessor` materializa el workspace (shallow clone en un volumen efímero aislado de red vía `cbd-fetcher`, luego escanea dentro de `cbd-scanner`), corre los **6 analizadores en paralelo**, y agrega.
8. **Persistir o reintegrar** — si puntuaron ≥ 4 de 6 categorías, persiste el `RepoScan` (`complete` = 6/6, `partial` = 4–5/6) y conserva la unidad de cuota. Si puntuaron < 4, marca el job `failed` y reintegra la unidad de cuota.
9. **El cliente hace polling a `GET /analyses/:id`** — todo estado no terminal de job colapsa a `analyzing` con un bloque `progress`; luego la respuesta terminal `completed` / `completed_partial` / `failed`.
10. **`StaleJobWatchdogService`** (en el worker, agendado) marca `failed` los jobs que quedaron colgados pasada su fecha límite y reintegra su cuota.
11. **`forceRescan: true`** (el botón "Re-scan") saltea los lookups de cache; el worker persiste vía `saveForced()`, que refresca la fila cacheada existente in-place — mismo `repo_scan.id`, para no invalidar los FK de jobs históricos.

La cache key es `(repoUrl, commitSha, engineVersion)`, donde `engineVersion` es un hash de la versión de cada analizador más la versión de su rúbrica — bumpear un analizador invalida automáticamente los scans cacheados obsoletos. Un índice único parcial (`WHERE status = 'complete'`) mantiene exactamente un scan completo por key, permitiendo igual que un scan `partial` del mismo commit sea superado más adelante.

---

## Stack

| Capa | Tecnologías |
| --- | --- |
| **Lenguaje / runtime** | TypeScript · Node.js ≥ 20.6 |
| **Backend** | NestJS 11 — dos procesos (HTTP + worker headless) · BullMQ sobre Redis |
| **Frontend** | React 19 · Vite 8 · Tailwind CSS 4 · i18n hecho a mano (es/en) |
| **Datos** | PostgreSQL 16 + Prisma 6 · Redis 7 (cola, cuota, rate-limit) |
| **Análisis** | Semgrep + OSV-Scanner (offline, en contenedor aislado) · juez LLM (Claude, o stub offline gratis) |
| **Ingesta** | Docker + dockerode — shallow-clone en un sandbox efímero sin red, nunca ejecuta código del repo |
| **Testing** | Vitest · Testcontainers (Postgres/Redis reales) · Strict TDD — 493 tests / 71 archivos |
| **Tooling** | pnpm 10 workspaces · graphify (grafo de conocimiento del repo) |

---

## Estructura del repositorio

```
apps/
  api/      Proceso HTTP NestJS — POST /analyses, GET /analyses/:id, filtro de errores RFC 9457, suite E2E
  worker/   Consumidor BullMQ headless — corre el pipeline de análisis; StaleJobWatchdogService + scheduler
  web/      SPA React 19 + Vite 8 + Tailwind 4 — features url-entry / progress / report / rescan
libs/
  analysis/     El dominio. Orquestador RepoAnalysisService, tipos de dominio, hash de engine-version,
                y los 6 ports: CategoryAnalyzer, RepoSourcePort, LLMJudgePort, ScoreRepositoryPort,
                UsageQuotaPort, HeadCallRateLimiterPort
  analyzers/    Los 6 adaptadores CategoryAnalyzer + AnalyzersModule (Semgrep/OSV, heurísticas, juez LLM)
  repo-source/  ShallowCloneAdapter — shallow-clone vía dockerode a un workspace efímero aislado de red
                (imágenes cbd-fetcher y luego cbd-scanner); parsing de URL, comandos git, topes de disco
  llm/          AnthropicJudgeAdapter (real, pago) / StubJudgeAdapter (gratis, offline); LlmModule.selectJudge()
  persistence/  Schema Prisma 6 + Postgres; cache de RepoScan, ciclo de vida de AnalysisJob, progreso por
                categoría, DailyFreeTierAdapter (cuota) y RedisHeadCallRateLimiterAdapter sobre Redis
  jobs/         Productor BullMQ (AnalysisQueueProducer) + consumidor (AnalysisProcessor)
scripts/
  portfolio/    Generan las capturas reales (Playwright) y las imágenes de portafolio (plantillas HTML → PNG)
docs/img/       Logo, hero, demo.gif y portfolio/ (portada, social preview, arquitectura, capturas)
```

---

## Puesta en marcha (desarrollo local)

Esta guía te lleva de un repo recién clonado a tener la aplicación analizando repositorios en tu máquina. Tarda entre 15 y 20 minutos la primera vez (casi todo es construir una imagen de Docker) y **no necesitás ninguna cuenta ni API key**: por defecto usa un juez LLM "stub" gratis y offline.

> Hay un recorrido más detallado, con el porqué de cada decisión, en [`DEV-HARNESS.md`](DEV-HARNESS.md).

### 1. Antes de empezar

| Herramienta | Versión | Cómo verificarla |
| --- | --- | --- |
| **Node.js** | 20.6 o superior (el CI usa 22) | `node -v` |
| **pnpm** | 10 | `pnpm -v` — si no lo tenés: `npm install -g pnpm@10` |
| **Docker** con Compose v2 | reciente | `docker compose version` y `docker ps` |

Además:

- Tu usuario tiene que poder usar Docker **sin `sudo`** (`docker ps` no debe dar "permission denied"; ver la tabla de problemas más abajo).
- Estos puertos tienen que estar **libres**: `3000` (API), `5173` (web), `5432` (Postgres) y `6379` (Redis).
- Unos 3 GB de disco libres y conexión a internet (se descargan imágenes y dependencias).
- Probado en **Linux** (Ubuntu 24.04, y el CI corre en Ubuntu). En macOS o Windows con Docker Desktop debería funcionar pero no lo probé; en Windows usá WSL2.

### 2. Qué vas a levantar

| Pieza | Qué es | Dónde corre |
| --- | --- | --- |
| Postgres y Redis | base de datos, cola de jobs, cuota y rate-limit | Docker (`docker compose`) |
| `cbd-fetcher` y `cbd-scanner` | los contenedores sandbox: uno clona el repo (con red), el otro lo analiza (**sin red**) | imágenes de Docker que construís vos una vez |
| API | recibe las peticiones HTTP | terminal 1 |
| Worker | toma los jobs de la cola y hace el análisis | terminal 2 |
| Web | la interfaz (React) | terminal 3 |

### 3. Paso a paso

Todos los comandos se corren **desde la raíz del repositorio**.

**Paso 1 — Instalar las dependencias**

```bash
pnpm install
```

Deberías ver, al final, algo como `Done in 20s`. Antes aparece un recuadro amarillo, `Ignored build scripts: @prisma/client, esbuild…`: **es normal** (pnpm 10 no ejecuta por defecto los scripts de instalación de algunos paquetes) y no hace falta aprobar nada; lo comprobé de punta a punta.

**Paso 2 — Construir las dos imágenes del sandbox**

```bash
pnpm docker:build
```

Es el paso más lento: la imagen del scanner incluye Semgrep y una base de datos de vulnerabilidades de OSV (unos 250 MB), así que la primera vez tarda **varios minutos**. Las siguientes veces usa la caché y tarda segundos. Para comprobar que quedaron:

```bash
docker image ls --filter "reference=cbd-*"
```

Tienen que aparecer `cbd-fetcher` y `cbd-scanner`, ambas con la etiqueta `local`.

**Paso 3 — Crear el archivo `.env`**

Copiá y pegá este bloque tal cual. Crea el `.env` con valores que ya coinciden con el `docker-compose.yml` y genera un secreto aleatorio:

```bash
cat > .env <<EOF
DATABASE_URL=postgresql://cbd:cbd@localhost:5432/codebase_doctor
REDIS_HOST=localhost
REDIS_PORT=6379
PORT=3000
LLM_JUDGE=stub
ACTOR_SALT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
EOF
```

| Variable | Para qué sirve |
| --- | --- |
| `DATABASE_URL` | cómo conectarse a Postgres (usuario y contraseña `cbd`, definidos en `docker-compose.yml`) |
| `REDIS_HOST` / `REDIS_PORT` | dónde está Redis |
| `PORT` | puerto de la API |
| `LLM_JUDGE=stub` | usa el juez falso y gratuito. Para uno real, ver [Juez LLM real y gratuito](#6-opcional-un-juez-llm-real-y-gratuito) |
| `ACTOR_SALT_SECRET` | secreto con el que se identifica a cada usuario de forma anónima (por IP hasheada) |

La lista completa de variables está en [Configuración](#configuración).

**Paso 4 — Levantar Postgres y Redis**

```bash
docker compose up -d --wait
```

Deberías ver `Healthy` junto a `cbd-postgres` y `cbd-redis`. Si el puerto `5432` o el `6379` ya están ocupados, mirá la tabla de problemas.

**Paso 5 — Preparar la base de datos**

```bash
pnpm db:generate
pnpm db:migrate
```

El segundo debería terminar diciendo que las migraciones se aplicaron (`All migrations have been successfully applied`).

**Paso 6 — Levantar los tres procesos**

Abrí **tres terminales**, todas en la raíz del repo, y corré un comando en cada una:

```bash
pnpm dev:api       # terminal 1 → API en http://localhost:3000
pnpm dev:worker    # terminal 2 → consumidor de la cola
pnpm dev:web       # terminal 3 → interfaz en http://localhost:5173
```

Qué deberías ver:

- **API:** `Nest application successfully started`.
- **Worker:** varias líneas `dependencies initialized` y un aviso `[cbd-llm] LLM_JUDGE=stub` (es normal: te recuerda que los puntajes del juez son falsos).
- **Web:** `Local: http://localhost:5173/`. Si ese puerto está ocupado, Vite elige el siguiente libre (5174, 5175…) y te lo dice: usá **la URL que te muestre**, no necesariamente la 5173.

**Paso 7 — Probarlo**

Abrí la URL que mostró la web en el navegador, pegá un repo de GitHub **público** y chico (por ejemplo `https://github.com/lukeed/clsx`) y tocá **Analizar repo**. Vas a ver el progreso por categoría y, en unos 20 segundos para un repo chico (hasta un minuto si es más grande), el reporte con las seis puntuaciones.

Con el juez `stub`, las tarjetas de **Arquitectura** y **Documentación** muestran la etiqueta `[stub verdict]`: son valores falsos y estables a propósito. El resto (Seguridad, Testing, Mantenibilidad, Rendimiento) es análisis real. Para que esas dos también las juzgue un LLM de verdad, mirá la sección siguiente.

Si preferís probar sin la interfaz:

```bash
curl -s -XPOST localhost:3000/analyses -H 'content-type: application/json' \
  -d '{"repoUrl":"https://github.com/lukeed/clsx","forceRescan":false}'
```

Devuelve un `jobId` (código `202`); consultalo con `curl -s localhost:3000/analyses/<jobId>` hasta que el estado sea `completed`.

### 4. Si algo falla

| Síntoma | Causa probable | Qué hacer |
| --- | --- | --- |
| `port is already allocated` o `address already in use` en el **5432** | Ya tenés un Postgres en tu máquina | `cp docker-compose.override.example.yml docker-compose.override.yml`, cambiá `5432` por `5433` en `DATABASE_URL` dentro de `.env`, y repetí `docker compose up -d --wait` |
| Lo mismo en el **6379** | Ya tenés un Redis corriendo | Detené ese Redis (por ejemplo `sudo systemctl stop redis`) y repetí el paso 4 |
| `permission denied while trying to connect to the Docker daemon socket` | Tu usuario no puede usar Docker | `sudo usermod -aG docker $USER`, cerrá la sesión y volvé a entrar |
| `Environment variable not found: DATABASE_URL` (Prisma) | No existe el `.env`, o no está en la **raíz** del repo | Repetí el paso 3 desde la raíz |
| `Can't reach database server` | Postgres no está levantado, o el puerto del `.env` no coincide | `docker compose ps` tiene que mostrar `healthy`; revisá el puerto de `DATABASE_URL` |
| `No such image: cbd-scanner:local` (o `cbd-fetcher:local`) | Falta construir las imágenes | Paso 2 |
| El análisis se queda en "pendiente" y no avanza | El worker no está corriendo, o quedaron procesos viejos | Mirá que la terminal 2 siga viva; si hay procesos colgados: `pkill -f 'src/main.ts'` y volvé a levantar los tres |
| "Cuota diaria de análisis superada" | El plan gratuito permite 5 análisis por día por usuario | En desarrollo: `docker exec cbd-postgres psql -U cbd -d codebase_doctor -c "update quota_reservation set state='refunded' where usage_date = current_date"` |
| Error con `--env-file-if-exists` al arrancar la API | Node anterior a 20.6 | Actualizá Node |

### 5. Apagar y empezar de cero

```bash
# Ctrl+C en las tres terminales, y después:
docker compose down        # apaga Postgres y Redis (conserva los datos)
docker compose down -v     # además BORRA la base de datos: empezás de cero
```

Para correr los tests: `pnpm test` (necesita Docker; ver [Tests](#tests)).

### 6. Opcional: un juez LLM real y gratuito

Para juzgar con un LLM real **sin pagar**, usá el adaptador OpenAI-compatible (`LLM_JUDGE=openai`). Cualquiera de estos proveedores tiene tier gratis o corre local:

| Proveedor | `LLM_BASE_URL` | `LLM_MODEL` de ejemplo | `LLM_API_KEY` |
| --- | --- | --- | --- |
| **Groq** ✅ | `https://api.groq.com/openai/v1` | `openai/gpt-oss-120b` | key gratis de console.groq.com |
| **Gemini** | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-2.0-flash` | key gratis de Google AI Studio |
| **OpenRouter** | `https://openrouter.ai/api/v1` | un modelo con sufijo `:free` | key de openrouter.ai |
| **Ollama** (local) | `http://localhost:11434/v1` | `llama3.2` | no hace falta |

Los tiers gratis tienen límites de requests por minuto/día; si se pasan, el proveedor responde `429` y esa categoría queda "no puntuada" (el scan sigue como `partial`). Los nombres de modelo cambian seguido (`llama-3.3-70b-versatile` ya no existe en Groq): consultá los disponibles con `curl https://api.groq.com/openai/v1/models -H "Authorization: Bearer $LLM_API_KEY"`. ✅ = probado contra el proveedor real; el resto de la tabla es compatible por protocolo pero no lo probé.

Para el juez de Anthropic (pago), poné `LLM_JUDGE=anthropic` y `ANTHROPIC_API_KEY`. En `NODE_ENV=production` la app **falla rápido al arrancar** si no hay un LLM real configurado — no va a servir puntajes fabricados en silencio.

---

## Tests

```bash
pnpm test          # Vitest (vitest run) — 71 archivos de test / 493 tests entre unit, integración y E2E
pnpm test:watch    # Vitest en modo watch
pnpm typecheck     # tsc --noEmit para el tsconfig raíz y para apps/web
```

- **Strict TDD** en todo — cada servicio se hizo test-first antes de cablearse a un proceso vivo.
- **Testcontainers** levanta Postgres y Redis reales para las suites de integración y E2E; esos specs necesitan un socket de Docker funcionando.
- Los tests de integración y E2E del analizador de Security corren **Semgrep y OSV-Scanner reales** dentro del contenedor `cbd-scanner`.
- Los escenarios E2E cubren el happy path, cache hit, rechazo de repo sobredimensionado, agotamiento de cuota, completado parcial, reintegro por debajo del umbral, y hallazgos de seguridad.

---

## Configuración

Toda la configuración del lado del host son variables de entorno; ver `.env.example`.

| Variable | Propósito | Default |
| --- | --- | --- |
| `DATABASE_URL` | Connection string de Postgres (Prisma) | — (`postgresql://<user>:<password>@localhost:<port>/codebase_doctor`) |
| `REDIS_HOST` | Host de Redis — cola BullMQ, contadores de cuota, contadores del rate-limiter | `localhost` |
| `REDIS_PORT` | Puerto de Redis | `6379` |
| `PORT` | Puerto HTTP de `apps/api` | `3000` |
| `UPGRADE_URL` | Link que aparece en el body del problem `quota-exceeded` | `https://codebasedoctor.dev/pricing` |
| `LLM_JUDGE` | `stub` (gratis, offline, determinista), `openai` (cualquier endpoint compatible con OpenAI — **tiers gratis**) o `anthropic` (real, pago) | `stub` |
| `LLM_BASE_URL` | URL base del endpoint OpenAI-compatible. Si está seteada y `LLM_JUDGE` no, se elige `openai` solo | — |
| `LLM_MODEL` | Modelo a usar con `LLM_JUDGE=openai` (ej. `openai/gpt-oss-120b`) | — |
| `LLM_API_KEY` | Key del proveedor OpenAI-compatible (opcional: Ollama local no necesita) | — |
| `ANTHROPIC_API_KEY` | Key de Anthropic — requerida cuando `LLM_JUDGE=anthropic` o cuando `LLM_JUDGE` está sin setear | — |
| `ACTOR_SALT_SECRET` | Secreto del salt diario con el que se hashea la IP del cliente (`openssl rand -hex 32`). **Obligatorio en `NODE_ENV=production`**: sin él la API no arranca | — (salt de dev con warning) |
| `TRUST_PROXY` | Confiar en `X-Forwarded-For`: cantidad de saltos (`1`), `loopback` o una subred. Necesario detrás de un proxy/PaaS; sin esto todos los usuarios comparten una sola cuota. **Opt-in** a propósito (sin proxy real, sería falsificable) | — (desactivado) |
| `CORS_ORIGINS` | Orígenes permitidos separados por coma (ej. `https://demo.midominio.dev`). Vacío = CORS apagado (mismo origen / proxy de Vite) | — |
| `STUB_JUDGE_FAIL_CATEGORIES` | Knob sólo-dev: `CategoryId`s separados por coma que el juez stub debe forzar-fallar (dispara el estado de reporte `partial`) | — (ninguna) |
| `NODE_ENV` | `production` hace que la selección del juez LLM falle rápido cuando no hay un LLM real configurado | `development` |

Las variables `CBD_SEMGREP_*` / `CBD_OSV_*` / `XDG_CACHE_HOME` se leen únicamente *dentro* del contenedor `cbd-scanner` (defaults horneados) — nunca en el host.

---

## API

Base URL en desarrollo local: `http://localhost:3000`.

### `POST /analyses`

```jsonc
// request
{ "repoUrl": "https://github.com/owner/repo", "forceRescan": false }
```

| Respuesta | Body |
| --- | --- |
| `202` — cache miss, job encolado | `{ "jobId", "status": "queued", "commitSha", "pollAfterMs": 2000, "quota" }` |
| `200` — cache hit | `{ "jobId": null, "status": "completed", "cached": true, "scanId", "quota", "result": RepoScoreReport }` |

### `GET /analyses/:id`

| Respuesta | Body |
| --- | --- |
| `404` | id desconocido |
| `202` — todavía corriendo | `{ "jobId", "status": "analyzing", "cached": false, "pollAfterMs": 2500, "progress": { "completed", "total", "categories": [{ "category", "status", "score" }] } }` |
| `200` — terminal | `{ "jobId", "status": "completed" \| "completed_partial", "cached": false, "result": RepoScoreReport }` |
| `200` — failed (genérico) | `{ "jobId", "status": "failed", "cached": false }` |
| `504 application/problem+json` — falló por timeout de clone/scan | body de problem RFC 9457 |

`RepoScoreReport` siempre trae **exactamente seis** entradas de categoría (una categoría nunca se descarta en silencio), un `compositeScore` (null si nada puntuó), `completeness` (`scoredCount / 6`), `status` (`complete` \| `partial`), y el mix de lenguajes detectado.

### Errores — RFC 9457 (`application/problem+json`)

| Status | `type` | Cuándo |
| --- | --- | --- |
| `400` | `/errors/invalid-repo-url` | La URL está malformada o no soportada |
| `422` | `/errors/repo-not-accessible` | Privado o inexistente — deliberadamente indistinguibles (`reason: "private" \| "not-found"`) |
| `422` | `/errors/repo-too-large` | Por encima del tope de bytes o de cantidad de archivos (ambas compuertas colapsan a este tipo) |
| `429` | `/errors/quota-exceeded` | Análisis diarios del free-tier agotados — incluye `Retry-After` y `upgradeUrl` |
| `429` | `/errors/rate-limited` | Llamadas de lookup del repo demasiado frecuentes — un tipo **distinto** del de cuota; incluye `Retry-After` |
| `504` | `/errors/scan-timeout` | El paso de clone o scan excedió su timeout (ambos colapsan a este tipo) |
| `500` | `about:blank` | Inesperado — ningún detalle interno se filtra al body |

---

## Decisiones y aprendizajes

Probar el sistema contra repos reales —no solo contra fixtures— destapó bugs que cientos de tests no veían. Cada uno se arregló con un test que lo reproduce primero:

- **Detección de README sensible a mayúsculas.** El analizador de Documentation buscaba nombres exactos (`README.md`), así que un `readme.md` figuraba como "sin README" y el juez puntuaba 15 un proyecto documentado (`p-limit`: 15 → 88).
- **Un falso positivo crítico en Semgrep.** La regla `dangerous-eval` marcaba como crítico cualquier `regex.exec(...)`, que es `RegExp#exec` y no ejecución de código; `commander.js` sacaba Security 60 (ahora 100). El test de integración usa Semgrep real y fija exactamente qué líneas se marcan.
- **Tests que no se reconocían.** `test.js` suelto, `*.test-d.ts` o carpetas `test/` daban "0 tests" (`p-limit`: 30 → 100). La escala ahora mide tests contra archivos *fuente*, no contra todos los archivos, y satura en 0.5 tests por archivo.
- **Un escaneo ~4× más lento de lo necesario.** Midiendo por etapas dentro del contenedor, Semgrep tardaba 46 s contra 2 s: esperaba ~44 s una consulta de versión por internet en un contenedor sin red. Con `--disable-version-check` un escaneo bajó de ~58 s a ~15 s. (La primera hipótesis, la copia de la base de OSV, se descartó midiendo.)
- **Fallos silenciosos.** Si Semgrep u OSV-Scanner fallaban, el indexer seguía con "0 hallazgos" y salía con código 0: un repo vulnerable podía verse limpio. Ahora las advertencias se registran.
- **Tests atados al reloj.** El del limitador usaba ventanas de 50 ms con el reloj real y fallaba si dos llamadas cruzaban el borde; ahora fija `Date.now`.

Una regla que atraviesa todo: cualquier corrección que cambia puntajes **sube la versión del analizador**, y como la versión forma parte de la clave de cache, los scans viejos se invalidan solos.

---

## Estado / roadmap

**MVP completo** — Fases 1–8: dominio y ports, los seis adaptadores de analizador, ingesta con sandbox de Docker, persistencia Prisma/Redis, la API HTTP con errores RFC 9457, el pipeline del worker con el watchdog de jobs colgados, la SPA de React, y la suite E2E sobre Postgres/Redis/Semgrep/OSV reales. Más: selector de idioma **ES / EN** (i18n de la UI + rationales de los analizadores deterministas), branding y guía de desarrollo local con juez LLM stub sin costo. Además: juez LLM gratuito (OpenAI-compatible), CI en GitHub Actions, licencia MIT, demo grabada y material de portafolio reproducible.

**Roadmap** (corto y honesto):

- Rationales de Architecture / Documentation en el idioma seleccionado — hoy los genera el juez LLM en inglés; requiere pasarle el locale al prompt.
- Validación de URL del lado del cliente antes de enviar (hoy el primer feedback ante una URL inválida es el round-trip del `400`).
- Constantes de rate-limit / cuota ajustadas — los valores de límite y ventana son una política fija horneada en los adaptadores.
- Un escenario E2E dedicado para scan-timeout (el camino del `504` tiene cobertura unit pero todavía no end-to-end).
- Truncar con "ver más" los rationales largos del juez: hoy un párrafo extenso estira la tarjeta y deja huecos en el reporte.
- Idioma inicial según `navigator.language` para quien entra por primera vez (hoy arranca en español).
- Un E2E de seguridad falló una vez en el CI (OSV-Scanner no devolvió hallazgos) y no se reproduce en local; ahora se registran las advertencias del scanner para diagnosticarlo si vuelve a pasar.

---

## Licencia

[MIT](LICENSE) © 2026 NogFait.
