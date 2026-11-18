# Local Dev Harness — codebase-doctor-mvp

Boot the whole stack locally with a **free, offline stub LLM** (zero API cost) and run a real
GitHub-repo analysis end to end. Every service in this repo was TDD'd via Testcontainers and had
**never** been run as a live system before this harness; the notes below are the result of doing
exactly that.

---

## 0. Prerequisites (already true on this machine)

- Node ≥ 20.6 (tested on **v24.11.0**) — needed for `--env-file` / `--env-file-if-exists`.
- pnpm (tested on **10.33.0**), `docker` + `docker compose`, working Docker socket.
- Docker images **`cbd-fetcher:local`** and **`cbd-scanner:local`** built and present
  (`docker images | grep cbd-`). If missing:
  ```bash
  # build context is apps/worker/docker (the Dockerfile's COPY paths are relative to it)
  docker build -f apps/worker/docker/cbd-fetcher.Dockerfile -t cbd-fetcher:local apps/worker/docker
  docker build -f apps/worker/docker/cbd-scanner.Dockerfile -t cbd-scanner:local apps/worker/docker
  ```

## 1. One-time setup added by this harness

| Change | Why |
| --- | --- |
| root `package.json` → `devDependencies.tsx` `4.23.13` (exact) | neither `apps/api` nor `apps/worker` had a runner; root already holds shared dev tooling (`typescript`, `vitest`) |
| `apps/api/package.json` + `apps/worker/package.json` → `scripts.start:dev` / `start:watch` | no npm scripts existed |
| `libs/llm/src/stub-judge-adapter.ts` (+ spec) | free, deterministic, offline `LLMJudgePort` — the only new production code |
| `libs/llm/src/llm.module.ts` | factory now picks stub vs. Anthropic from env |
| `docker-compose.override.yml` | remaps Postgres to host **5433** (native Postgres already owns 5432 here). Local and git-ignored since the README guide was rewritten; the tracked template is `docker-compose.override.example.yml` |
| `.env` / `.env.example` | **could not be written by the agent** (permission policy blocks `.env*`). Create manually — see §2. |

### The `start:dev` script

```jsonc
"start:dev":   "tsx --tsconfig ../../tsconfig.json --env-file-if-exists=../../.env src/main.ts",
"start:watch": "tsx watch --tsconfig ../../tsconfig.json --env-file-if-exists=../../.env src/main.ts",
```

- **`--tsconfig ../../tsconfig.json` is load-bearing.** The per-app `apps/*/tsconfig.json` only
  `include`s `["src"]`, so tsx/esbuild applies its `compilerOptions` *only* to files under
  `apps/api/src` — **not** to the `libs/*` packages `main.ts` imports. esbuild then falls back to
  TC39 decorators and dies with `Parameter decorators only work when experimental decorators are
  enabled` on the first `@Inject()` in `libs/analysis`. The **root** `tsconfig.json`
  (`include: ["apps/**/src", "libs/**/src", ...]`, `experimentalDecorators` + `emitDecoratorMetadata`
  via `tsconfig.base.json`) covers both trees, so pointing tsx at it fixes every Nest DI decorator.
- **`--env-file-if-exists` (not `--env-file`)** so the script still runs if `.env` is absent; env
  can also come from the parent shell (that is how the agent ran it — see §3).
- **Plain `tsx`, not `tsx watch`**, for `start:dev`: `watch` re-runs on any change under the whole
  workspace (incl. `libs/**`), which restarts api/worker mid-analysis. Use `start:watch` for
  interactive work on a quiet tree.
- DI works under tsx because this codebase already annotates **every** constructor param with an
  explicit `@Inject(TOKEN)` (it distrusts ambient `design:paramtypes` reflection under its
  Vitest/esbuild transform) — so no reflection metadata is actually required at runtime.

## 2. `.env` (create at repo root — `.gitignore` already ignores `.env`)

```dotenv
DATABASE_URL=postgresql://cbd:cbd@localhost:5433/codebase_doctor
REDIS_HOST=localhost
REDIS_PORT=6379
PORT=3000
LLM_JUDGE=stub
```

> Note the **5433** — see §4 step 1. If nothing else owns host 5432, use 5432 and drop
> `docker-compose.override.yml`.

`.env.example` — same keys plus:

```dotenv
# LLM_JUDGE: stub (free, offline, deterministic — default) | anthropic (real, PAID, needs a key)
ANTHROPIC_API_KEY=
# Optional StubJudgeAdapter dev knob — comma-separated CategoryIds to force-fail:
#   architecture,security,testing,maintainability,performance,documentation
# 1 failing LLM category  -> report status "completed_partial"
# STUB_JUDGE_FAIL_CATEGORIES=architecture
```

Only `DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`, `PORT` are read on the host. The
`CBD_SEMGREP_*` / `CBD_OSV_*` / `XDG_CACHE_HOME` vars are read only *inside* the `cbd-scanner`
container (baked defaults), never on the host.

## 3. Free stub LLM judge — `StubJudgeAdapter`

`libs/llm/src/stub-judge-adapter.ts` — `implements LLMJudgePort`, zero cost, no network, no SDK.

- **Deterministic**: verdict is a djb2 hash of `category + rubricId`. Same request → same verdict,
  so a re-scan of the same commit reproduces identically.
- **Pseudo-varied per category**: each `CategoryId` owns a non-overlapping 6-point score lane
  inside 55–90 (`architecture` 55–60 … `documentation` 85–90) → the six report cards always show
  distinct numbers.
- `modelId: "stub-judge"`, `promptTokens: 0`, `completionTokens: 0`, rationale is a readable
  sentence that names the category and says `[stub verdict] … generated offline … without an LLM`.
- Honours an already-aborted `AbortSignal` (`signal.throwIfAborted()`).
- `STUB_JUDGE_FAIL_CATEGORIES` env (comma-separated) **or** `new StubJudgeAdapter({ failCategories })`
  → `judge()` throws for those categories (drives the `completed_partial` report state).

`libs/llm/src/llm.module.ts` selection (env-injectable factory):

```ts
export function selectJudge(env: NodeJS.ProcessEnv = process.env): LLMJudgePort {
  const mode = env.LLM_JUDGE?.trim().toLowerCase();

  if (mode === "stub") { /* warn: scores are fabricated */ return new StubJudgeAdapter(); }
  if (mode === "anthropic" || env.ANTHROPIC_API_KEY) return new AnthropicJudgeAdapter();

  // LLM_JUDGE unset/unrecognised AND no ANTHROPIC_API_KEY:
  if (env.NODE_ENV === "production") {
    throw new Error("[cbd-llm] Refusing to start: no LLM_JUDGE and no ANTHROPIC_API_KEY …");
  }
  // non-production: loud warn + fall back to the stub
  return new StubJudgeAdapter();
}
```

| `LLM_JUDGE` | `ANTHROPIC_API_KEY` | `NODE_ENV`      | Result                                   |
|-------------|---------------------|----------------|------------------------------------------|
| `stub`      | any                 | any            | `StubJudgeAdapter` + warn (opt-in)       |
| `anthropic` | any                 | any            | `AnthropicJudgeAdapter`                  |
| unset/other | present             | any            | `AnthropicJudgeAdapter`                  |
| unset/other | absent              | `!= production`| `StubJudgeAdapter` + loud fallback warn  |
| unset/other | absent              | `== production`| **throws at factory time** (fail-fast)   |

`ScriptedJudge` and its spec are untouched. Only `architecture` and `documentation` route through
the judge; the other four categories are computed by deterministic analyzers (Semgrep/OSV, file
heuristics), so at most **2 of 6** verdicts ever come from the stub.

## 4. Bring the stack up — exact commands

```bash
# --- 1. infra ---------------------------------------------------------------
docker compose up -d           # postgres (host 5433 via docker-compose.override.yml) + redis (6379)
# wait for health:
until [ "$(docker inspect -f '{{.State.Health.Status}}' cbd-postgres)" = healthy ] \
   && [ "$(docker inspect -f '{{.State.Health.Status}}' cbd-redis)" = healthy ]; do sleep 2; done

# --- 2. prisma --------------------------------------------------------------
# Both scripts load the repo-root .env themselves (dotenv -e ../../.env).
pnpm --filter @cbd/persistence prisma:generate
pnpm --filter @cbd/persistence prisma:migrate   # applies the migrations in prisma/migrations

# --- 3. app processes (each in its own shell) ------------------------------
# api + worker load ../../.env via tsx --env-file-if-exists; web (vite) needs
# nothing on the host. No manual `export` required.

pnpm --filter @cbd/api    start:dev     # Nest HTTP on :3000  ("Mapped {/analyses, POST}")
pnpm --filter @cbd/worker start:dev     # headless BullMQ consumer (Redis bzpopmin on 'analysis')
pnpm --filter @cbd/web    dev           # vite; :5173 if free (this machine: 5173/5174 taken -> 5175)

# --- 4. smoke ---------------------------------------------------------------
curl -s localhost:3000/analyses/x -o /dev/null -w '%{http_code}\n'   # 404 = serving
curl -s -XPOST localhost:3000/analyses -H 'content-type: application/json' \
  -d '{"repoUrl":"https://github.com/tj/commander.js","forceRescan":false}'   # -> {"jobId":...,"status":"queued"}
```

Health confirmed on first run:

| Service | Result |
| --- | --- |
| `@cbd/api` | boots clean, `NestApplication successfully started`, `POST /analyses` + `GET /analyses/:id` mapped, `:3000` serves (404 on `/`). |
| `@cbd/worker` | `createApplicationContext` OK, all modules init (`LlmModule`, `JobsConsumerModule`, `AnalysisDomainModule`, `ScheduleModule`), Redis `bzpopmin` blocking-consumer + `bull:analysis:{meta,stalled-check}` keys → BullMQ consumer live. No DI errors. |
| `@cbd/web` | vite serves (5175 here — 5173/5174 held by another project's containers). `/analyses` proxy → `:3000` unchanged. |
| pipeline | `commander.js` fetched (HEAD → commitSha), scanned in `cbd-scanner:local`, 6/6 categories scored, `status: complete`, composite **63.55**. `p-limit` via the browser: 6/6 scored, composite **74.36**, `[stub verdict]` on architecture (60) + documentation (86). |

### Port conflicts seen on this machine (and the fixes)

| Port | Owner | Fix |
| --- | --- | --- |
| 5432 | native host Postgres | `docker-compose.override.yml` publishes cbd-postgres on **5433** (`ports: !override`); `DATABASE_URL` uses 5433 |
| 5173 / 5174 | another project's `front-*` docker containers | vite auto-advances to **5175** — the `/analyses` proxy target is unaffected |
| 6379, 3000 | free | — |

## 5. Run one real analysis + capture the frontend states

`claude-in-chrome` was unavailable, so **playwright-core `1.62.1`** (added as a root devDependency)
drives the cached system Chromium at
`~/.cache/ms-playwright/chromium-1200/chrome-linux64/chrome` via an explicit `executablePath`
(sidesteps browser-revision checks). Scripts live in the session scratchpad
(`shoot.mjs`, `one.mjs`, `failed2.mjs`).

Captured the first time by hand-written scratch scripts (`phase7-<state>.png`, since replaced). They are now
reproducible with `scripts/portfolio/capture-screenshots.mjs` and `capture-states.mjs` (output in
`docs/img/portfolio/`; see its README). The states, and how each one is forced:

| State | How |
| --- | --- |
| **entry** | load `/`, screenshot the URL form |
| **progress** | submit `https://github.com/sindresorhus/p-limit`; screenshot `section[aria-label="Scan progress"]` — "Scanning repository…" then the 6 `category: pending` rows during clone+scan |
| **report** | wait for `section[aria-label="Scan report"]` — composite 74.36, 6 cards, `[stub verdict]` + "Judged" pill on architecture/documentation, "N analyses left today" quota, "Re-scan" / "Analyze another repo" |
| **completed_partial** | worker started with `STUB_JUDGE_FAIL_CATEGORIES=architecture`, p-limit cache row deleted, fresh scan → "Partial report", amber "Some categories could not be scored", Architecture card "Could not be scored" + "Retry" |
| **failed** | with no worker running, flip the fresh `analysis_job` row to `status='failed'` in Postgres while the browser polls → `GET /analyses/:id` returns `failed` → ProgressView → ReportView failed branch (red panel + quota-refund notice + "Try again") |

### Gotchas found while doing this

1. **`forceRescan` does not reach the worker.** `SubmitAnalysisUseCase` skips its cache check on
   `forceRescan:true`, but `RepoAnalysisService.analyze()` *unconditionally* re-checks
   `scores.findCached({repoUrl, commitSha, engineVersion})` (status `complete` only) and returns the
   cached scan — so a "Re-scan" of an already-complete repo shows a brief progress flash then the
   **same** cached report; no analyzers run, no new `repo_scan` row. To truly re-run in dev:
   `DELETE FROM repo_scan WHERE repo_url LIKE '%<repo>%';` first. (Design intent per
   `repo-analysis.service.ts` L72 is cache-key parity across processes; whether `forceRescan` should
   propagate is a product question, not a harness bug.)
2. **Job-level `failed` is unreachable via the stub knob.** `MIN_SCORED_CATEGORIES = 4`; only
   architecture + documentation use the judge, so `STUB_JUDGE_FAIL_CATEGORIES` can drop at most 2
   → still 4 scored → always `completed_partial`. A real `failed` needs a pipeline throw
   (clone/scan timeout) or the stale-job watchdog — captured here by flipping the DB row instead.
3. **`pnpm … start:dev &` leaves an orphan tree.** `pnpm` → `sh -c tsx …` → `node tsx` → `node
   --import tsx`. Killing the tracked background job reaps only `pnpm`; the `sh`/`node` children
   keep consuming the queue. Kill by PID (`pgrep -f 'src/main.ts'`) or `pkill -f 'tsx .* src/main.ts'`.
   Two orphaned workers on the same queue make failure-injection non-deterministic.

## 6. Tear down

```bash
# stop the 3 app processes (orphan-safe):
pkill -f 'tsx --tsconfig .*src/main.ts'      # api + worker
pkill -f 'vite'                              # web  (scope carefully if other vite servers run)

docker compose down                          # keep volume + images
# docker compose down -v                     # also drop the Postgres volume for a clean DB

graphify update .
pnpm typecheck
pnpm test
```

Leave the large uncommitted Phase-7 working tree as-is. **Do not commit** the harness files
(`.env`, `docker-compose.override.yml`, `tsx`/`playwright-core` in `package.json`,
`stub-judge-adapter*`, this file) unless you decide to keep them.
