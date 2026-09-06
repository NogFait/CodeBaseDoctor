import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import request from "supertest";
import { REPO_SOURCE_PORT, LLM_JUDGE_PORT, type CategoryId, type JudgeVerdict } from "@cbd/analysis";
import { ShallowCloneAdapter } from "@cbd/repo-source";
import { startTestDatabase, type TestDatabase } from "@cbd/persistence/testing/postgres-test-db";
import { ScriptedJudge } from "@cbd/llm/testing/scripted-judge";
import { ProblemDetailsFilter } from "../../errors/problem-details.filter";
import { E2eRepoSource } from "./e2e-repo-source";

/**
 * Phase 8 E2E harness — shared by tasks 8.1/8.2/8.7 (this batch) and the
 * follow-up 8.3-8.6 batch (quota exhaustion, oversized repo, partial
 * completion, below-threshold+refund). Generic on purpose: nothing in this
 * file is scenario-specific.
 *
 * What "E2E" means here (design's own testing strategy table + tasks.md):
 * real HTTP `ApiModule`, a REAL running `WorkerModule` (its
 * `AnalysisProcessor` genuinely dequeuing and processing jobs via a real
 * BullMQ `Worker`), both pointed at the SAME real Testcontainers Postgres
 * and the SAME real Testcontainers Redis, real Docker for repo ingestion
 * (`ShallowCloneAdapter`, real `cbd-fetcher`/`cbd-scanner` images) and the 6
 * REAL `CategoryAnalyzer`s — EXCEPT the LLM judge, swapped for
 * `ScriptedJudge` so Architecture/Documentation are deterministic and no
 * real Anthropic credits are spent.
 *
 * apiApp and workerApp are two separate Nest DI containers, but BOTH live
 * in this ONE Node process/test file — there is no real inter-process
 * boundary here (BullMQ still talks over real Redis exactly as it would
 * across two real processes; only the OS-process split is not reproduced).
 *
 * ## Import-order landmine (read before touching this file)
 *
 * `ApiModule` and `WorkerModule` MUST be imported dynamically, and ONLY
 * after `process.env.REDIS_HOST`/`REDIS_PORT` are set below. Both
 * transitively import `@cbd/jobs`'s `JobsProducerModule`/
 * `JobsConsumerModule`, whose `@Module({imports:
 * [BullModule.forRoot({connection:{host: process.env.REDIS_HOST ?? ...}})]
 * })` decorator ARGUMENT is evaluated the instant that file is
 * imported/required — decorators run at class-definition time, not lazily
 * inside Nest's DI container. This is DIFFERENT from `PrismaService`, which
 * reads `DATABASE_URL` lazily inside `PrismaClient`'s own constructor
 * (invoked only when Nest actually instantiates the provider during
 * `.compile()`). A static top-level import of `ApiModule`/`WorkerModule`
 * anywhere in this file (or transitively, e.g. importing `SubmitAnalysisUseCase`
 * or `AnalysesController` directly, both of which pull in `@cbd/jobs`) would
 * freeze the Redis connection options to whatever `REDIS_HOST`/`REDIS_PORT`
 * were (or weren't) BEFORE the Testcontainers Redis below even exists.
 */

export interface E2eEnvironment {
  /** The compiled+initialized API Nest application (real HTTP). */
  apiApp: INestApplication;
  /** `apiApp.getHttpServer()` — pass this straight to `supertest(...)`. */
  apiServer: ReturnType<INestApplication["getHttpServer"]>;
  /** The compiled+initialized Worker Nest application (headless — no HTTP
   * listener, mirrors `apps/worker/src/main.ts`'s
   * `NestFactory.createApplicationContext(WorkerModule)`). Its real
   * `AnalysisProcessor` is genuinely dequeuing from the same Redis the API
   * enqueues into. */
  workerApp: INestApplication;
  /** Shared `RepoSourcePort` override bound into BOTH apps. Call
   * `.register(githubUrl, realFixtureUrl)` before a scenario's `POST
   * /analyses` — see `E2eRepoSource`'s own doc comment. */
  repoSource: E2eRepoSource;
  /** The LIVE, mutable script backing the single `ScriptedJudge` instance
   * bound into the worker app for its whole lifetime. Call `.set(category,
   * verdict-or-error)` before a scenario that needs Architecture/
   * Documentation scored (or made to fail) — `ScriptedJudge.judge()` reads
   * this map by reference on every call, so mutating it between scenarios
   * reconfigures the SAME injected instance without recompiling anything. */
  judgeScript: Map<CategoryId, JudgeVerdict | Error>;
  /** The Testcontainers Postgres handle (real `PrismaClient`, real
   * connection string) — use `db.prisma` for out-of-band assertions/setup
   * (e.g. counting `analysis_job` rows, truncating between tests). */
  db: TestDatabase;
  /** Closes both Nest apps and stops both containers. No dangling
   * Testcontainers Postgres/Redis after this resolves. */
  stop(): Promise<void>;
}

export async function startE2eEnvironment(): Promise<E2eEnvironment> {
  const redisContainer: StartedRedisContainer = await new RedisContainer("redis:7-alpine").start();
  const db = await startTestDatabase();

  process.env.DATABASE_URL = db.connectionUri;
  process.env.REDIS_HOST = redisContainer.getHost();
  process.env.REDIS_PORT = String(redisContainer.getMappedPort(6379));

  // See the file-level doc comment: MUST stay dynamic, MUST stay after the
  // three env var assignments above.
  const [{ ApiModule }, { WorkerModule }] = await Promise.all([
    import("../../api.module"),
    import("@cbd/worker/src/worker.module"),
  ]);

  const repoSource = new E2eRepoSource(new ShallowCloneAdapter());
  const judgeScript = new Map<CategoryId, JudgeVerdict | Error>();
  const scriptedJudge = new ScriptedJudge(judgeScript);

  const apiModuleRef = await Test.createTestingModule({ imports: [ApiModule] })
    .overrideProvider(REPO_SOURCE_PORT)
    .useValue(repoSource)
    .compile();
  const apiApp = apiModuleRef.createNestApplication();
  // Mirrors apps/api/src/main.ts's own bootstrap wiring exactly (the filter
  // has zero DI deps of its own, wired at the bootstrap edge there too).
  apiApp.useGlobalFilters(new ProblemDetailsFilter());
  await apiApp.init();

  const workerModuleRef = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(REPO_SOURCE_PORT)
    .useValue(repoSource)
    .overrideProvider(LLM_JUDGE_PORT)
    .useValue(scriptedJudge)
    .compile();
  const workerApp = workerModuleRef.createNestApplication();
  // `.init()` (not just `.compile()`) is required for the real BullMQ
  // Worker to actually start: `@nestjs/bullmq`'s `@Processor`/`WorkerHost`
  // explorer only activates on full Nest application lifecycle hooks
  // (onModuleInit/onApplicationBootstrap), not on a bare `.compile()` — see
  // apply-progress (obs #937), batch 2026-09-05, Learned #4/#6. `.init()`
  // on a `createNestApplication()`-derived `INestApplication` runs the same
  // lifecycle hooks as production's `NestFactory.createApplicationContext`.
  await workerApp.init();

  return {
    apiApp,
    apiServer: apiApp.getHttpServer(),
    workerApp,
    repoSource,
    judgeScript,
    db,
    async stop() {
      await apiApp.close();
      await workerApp.close();
      await db.stop();
      await redisContainer.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// Poll helper
// ---------------------------------------------------------------------------

export interface AnalysisProgressCategoryJson {
  category: string;
  status: string;
  score: number | null;
}

export interface FindingJson {
  ruleId: string;
  severity: string;
  path?: string;
  line?: number;
  message: string;
}

export interface CategoryScoreJson {
  category: string;
  status: "scored" | "failed" | "skipped";
  score: number | null;
  confidence: string;
  weightCap: number;
  rationale: string;
  findings: FindingJson[];
  error?: { code: string; message: string };
  durationMs: number;
}

/** `RepoScan` as it arrives over HTTP (JSON) — `createdAt` is a string, not a `Date`. */
export interface RepoScanJson {
  id: string;
  repoUrl: string;
  commitSha: string;
  engineVersion: string;
  status: "complete" | "partial";
  compositeScore: number | null;
  completeness: number;
  dominantLanguage: string | null;
  languageMix: { language: string; loc: number; share: number }[];
  categories: CategoryScoreJson[];
  createdAt: string;
}

/** `GET /analyses/:id`'s response body — mirrors `AnalysisStatusResponse`
 * (get-analysis-response.ts) as it arrives over HTTP. */
export interface AnalysisPollResponse {
  jobId: string | null;
  status: "analyzing" | "completed" | "completed_partial" | "failed";
  cached: boolean;
  pollAfterMs?: number;
  progress?: { completed: number; total: number; categories: AnalysisProgressCategoryJson[] };
  result?: RepoScanJson;
}

export interface PollOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

const DEFAULT_POLL_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * Repeatedly `GET /analyses/:id` until `status` is no longer `"analyzing"`,
 * or throws once `options.timeoutMs` elapses — a real bug (e.g. a hung
 * analyzer, a wedged BullMQ worker) must fail the TEST, not hang the whole
 * suite forever.
 */
export async function pollUntilTerminal(
  server: E2eEnvironment["apiServer"],
  jobId: string,
  options: PollOptions = {},
): Promise<AnalysisPollResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let last: AnalysisPollResponse | undefined;

  while (Date.now() < deadline) {
    const res = await request(server).get(`/analyses/${jobId}`);
    last = res.body as AnalysisPollResponse;
    if (last.status !== "analyzing") {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `pollUntilTerminal: job ${jobId} did not reach a terminal status within ${timeoutMs}ms ` +
      `(last response: ${JSON.stringify(last)})`,
  );
}
