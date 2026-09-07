import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import {
  HEAD_CALL_RATE_LIMITER_PORT,
  REPO_SOURCE_PORT,
  SCORE_REPOSITORY_PORT,
  USAGE_QUOTA_PORT,
  RepoNotAccessibleError,
  RepoTooLargeError,
  type CategoryId,
  type CategoryScore,
  type HeadCallRateLimiterPort,
  type IngestionLimits,
  type RepoMetadata,
  type RepoRef,
  type RepoScan,
  type RepoSourcePort,
  type RepoWorkspace,
} from "@cbd/analysis";
import type { AnalysisJobCategoryRow, AnalysisJobRecord, JobStatus } from "@cbd/persistence";
import { InMemoryScoreRepository } from "@cbd/persistence/testing/in-memory-score-repository";
import { InMemoryQuota } from "@cbd/persistence/testing/in-memory-quota";
import { AnalysisJobRepository } from "@cbd/persistence";
import { AnalysisQueueProducer } from "@cbd/jobs";
import { AnalysesController } from "./analyses.controller";
import { SubmitAnalysisUseCase, type AnalysisJobCreateInput } from "./submit-analysis.use-case";
import { ProblemDetailsFilter } from "../errors/problem-details.filter";

const REPO_URL = "https://github.com/fixture/well-tested-ts";
const HEAD_SHA = "a".repeat(40);
const ALL_CATEGORIES: readonly CategoryId[] = [
  "security",
  "testing",
  "maintainability",
  "architecture",
  "documentation",
  "performance",
];

class FakeRepoSource implements RepoSourcePort {
  resolveImpl: (url: string) => Promise<RepoRef> = async (url) => ({
    host: "github",
    owner: "fixture",
    repo: "well-tested-ts",
    url,
  });
  headImpl: (ref: RepoRef) => Promise<RepoMetadata> = async () => ({
    defaultBranch: "main",
    headSha: HEAD_SHA,
    sizeKb: 10,
    visibility: "public",
  });

  async resolve(url: string): Promise<RepoRef> {
    return this.resolveImpl(url);
  }
  async head(ref: RepoRef): Promise<RepoMetadata> {
    return this.headImpl(ref);
  }
  async materialize(_ref: RepoRef, _sha: string, _limits: IngestionLimits): Promise<RepoWorkspace> {
    throw new Error("must never be called from apps/api");
  }
}

/** Fake standing in for the real Prisma-backed AnalysisJobRepository — an
 * in-memory Map is enough to drive both the POST (create/attachBullJobId)
 * and GET (findById) paths, plus updateStatus() to simulate what the
 * (not-yet-built) worker processor will do to a job over its lifecycle. */
class FakeAnalysisJobRepository {
  private readonly rows = new Map<string, AnalysisJobRecord>();
  private counter = 0;

  async create(input: AnalysisJobCreateInput): Promise<{ id: string }> {
    const id = `job-${++this.counter}`;
    const now = new Date();
    const categories: AnalysisJobCategoryRow[] = ALL_CATEGORIES.map((category) => ({
      category,
      status: "pending",
      score: null,
      confidence: null,
      rationale: null,
      findings: [],
      errorCode: null,
      durationMs: null,
      updatedAt: now,
    }));
    this.rows.set(id, {
      id,
      repoUrl: input.repoUrl,
      commitSha: input.commitSha ?? null,
      engineVersion: input.engineVersion,
      actorId: input.actorId,
      reservationId: input.reservationId,
      status: "queued",
      errorCode: null,
      errorMessage: null,
      repoScanId: null,
      bullJobId: null,
      attempts: 0,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      categories,
    });
    return { id };
  }

  async findById(id: string): Promise<AnalysisJobRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async attachBullJobId(id: string, bullJobId: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.bullJobId = bullJobId;
  }

  /** Simulates what the worker processor (AnalysisProcessor,
   * libs/jobs/src/analysis-processor.ts) does to a job's row — this is NOT
   * exercising a real end-to-end pipeline, only the job-table state
   * transition the GET endpoint reads. `errorCode`/`errorMessage` mirror
   * what `describeError()` there writes on a caught failure (e.g.
   * `ScanTimeoutError`/`CloneTimeoutError`). */
  async updateStatus(
    id: string,
    status: JobStatus,
    extra: { repoScanId?: string; errorCode?: string; errorMessage?: string } = {},
  ): Promise<void> {
    const row = this.rows.get(id);
    if (!row) throw new Error(`FakeAnalysisJobRepository: no job "${id}"`);
    row.status = status;
    if (extra.repoScanId !== undefined) row.repoScanId = extra.repoScanId;
    if (extra.errorCode !== undefined) row.errorCode = extra.errorCode;
    if (extra.errorMessage !== undefined) row.errorMessage = extra.errorMessage;
  }
}

class FakeAnalysisQueueProducer {
  private counter = 0;
  async enqueue(): Promise<string> {
    return `bull-${++this.counter}`;
  }
}

function sixScoredCategories(): CategoryScore[] {
  return ALL_CATEGORIES.map((category) => ({
    category,
    status: "scored",
    score: 80,
    confidence: "measured",
    weightCap: category === "performance" ? 0.5 : 1,
    rationale: `${category} looks fine`,
    findings: [],
    durationMs: 5,
  }));
}

/** Fix C — always allows every attempt; not exercised by this controller
 * suite's own scenarios (that's submit-analysis.use-case.spec.ts's job),
 * just needs to be bound so SubmitAnalysisUseCase's DI graph resolves. */
class FakeHeadCallRateLimiter implements HeadCallRateLimiterPort {
  async checkAndRecord(): Promise<void> {}
}

interface Fixture {
  app: INestApplication;
  repoSource: FakeRepoSource;
  scores: InMemoryScoreRepository;
  quota: InMemoryQuota;
  jobs: FakeAnalysisJobRepository;
  useCase: SubmitAnalysisUseCase;
}

async function buildApp(
  overrides: Partial<{ repoSource: FakeRepoSource; scores: InMemoryScoreRepository; quota: InMemoryQuota }> = {},
): Promise<Fixture> {
  const repoSource = overrides.repoSource ?? new FakeRepoSource();
  const scores = overrides.scores ?? new InMemoryScoreRepository();
  const quota = overrides.quota ?? new InMemoryQuota();
  const jobs = new FakeAnalysisJobRepository();
  const queueProducer = new FakeAnalysisQueueProducer();

  const moduleRef = await Test.createTestingModule({
    controllers: [AnalysesController],
    providers: [
      SubmitAnalysisUseCase,
      { provide: REPO_SOURCE_PORT, useValue: repoSource },
      { provide: SCORE_REPOSITORY_PORT, useValue: scores },
      { provide: USAGE_QUOTA_PORT, useValue: quota },
      { provide: HEAD_CALL_RATE_LIMITER_PORT, useValue: new FakeHeadCallRateLimiter() },
      { provide: AnalysisJobRepository, useValue: jobs },
      { provide: AnalysisQueueProducer, useValue: queueProducer },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();

  const useCase = moduleRef.get(SubmitAnalysisUseCase);
  return { app, repoSource, scores, quota, jobs, useCase };
}

describe("AnalysesController", () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    await fixture?.app.close();
    fixture = undefined;
  });

  describe("POST /analyses", () => {
    it("valid repo + available quota -> 202 queued", async () => {
      fixture = await buildApp();

      const res = await request(fixture.app.getHttpServer()).post("/analyses").send({ repoUrl: REPO_URL });

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ status: "queued", commitSha: HEAD_SHA, pollAfterMs: 2000 });
      expect(typeof res.body.jobId).toBe("string");
      expect(res.body.quota).toMatchObject({ tier: "free" });
    });

    it("valid repo with an existing cache hit -> 200 cached, no job created", async () => {
      fixture = await buildApp();
      await fixture.scores.save({
        repoUrl: REPO_URL,
        commitSha: HEAD_SHA,
        engineVersion: fixture.useCase.engineVersion,
        status: "complete",
        compositeScore: 80,
        completeness: 1,
        dominantLanguage: "TypeScript",
        languageMix: [],
        categories: sixScoredCategories(),
        createdAt: new Date(),
      });

      const res = await request(fixture.app.getHttpServer()).post("/analyses").send({ repoUrl: REPO_URL });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ jobId: null, status: "completed", cached: true });
      expect(typeof res.body.scanId).toBe("string");
      expect(res.body.result.repoUrl).toBe(REPO_URL);
    });

    it("malformed/missing repoUrl -> 400 problem+json /errors/invalid-repo-url", async () => {
      fixture = await buildApp();

      const res = await request(fixture.app.getHttpServer()).post("/analyses").send({});

      expect(res.status).toBe(400);
      expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({ type: "/errors/invalid-repo-url", status: 400 });
    });

    it("private repo -> 422 problem+json /errors/repo-not-accessible", async () => {
      const repoSource = new FakeRepoSource();
      repoSource.headImpl = async () => {
        throw new RepoNotAccessibleError(REPO_URL, "private");
      };
      fixture = await buildApp({ repoSource });

      const res = await request(fixture.app.getHttpServer()).post("/analyses").send({ repoUrl: REPO_URL });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({
        type: "/errors/repo-not-accessible",
        status: 422,
        repoUrl: REPO_URL,
        reason: "private",
      });
    });

    it("oversized repo -> 422 problem+json /errors/repo-too-large", async () => {
      const repoSource = new FakeRepoSource();
      repoSource.headImpl = async () => {
        throw new RepoTooLargeError({ maxBytes: 500_000_000, maxFiles: 50_000 }, { sizeKb: 900_000 });
      };
      fixture = await buildApp({ repoSource });

      const res = await request(fixture.app.getHttpServer()).post("/analyses").send({ repoUrl: REPO_URL });

      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ type: "/errors/repo-too-large", status: 422 });
    });

    it("quota exceeded -> 429 problem+json /errors/quota-exceeded with a Retry-After header", async () => {
      fixture = await buildApp({ quota: new InMemoryQuota({ limit: 0 }) });

      const res = await request(fixture.app.getHttpServer()).post("/analyses").send({ repoUrl: REPO_URL });

      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ type: "/errors/quota-exceeded", status: 429 });
      expect(res.headers["retry-after"]).toBeDefined();
    });
  });

  describe("GET /analyses/:id", () => {
    it("unknown id -> 404", async () => {
      fixture = await buildApp();

      const res = await request(fixture.app.getHttpServer()).get("/analyses/does-not-exist");

      expect(res.status).toBe(404);
    });

    it("in-progress job -> 202 with per-category progress (all pending — no worker exists yet in this batch)", async () => {
      fixture = await buildApp();
      const submitRes = await request(fixture.app.getHttpServer()).post("/analyses").send({ repoUrl: REPO_URL });
      const jobId = submitRes.body.jobId as string;

      const res = await request(fixture.app.getHttpServer()).get(`/analyses/${jobId}`);

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ jobId, status: "analyzing", cached: false });
      expect(res.body.progress.total).toBe(6);
      expect(res.body.progress.completed).toBe(0);
      expect(res.body.progress.categories).toHaveLength(6);
    });

    it("completed job -> 200 with the full result", async () => {
      fixture = await buildApp();
      const submitRes = await request(fixture.app.getHttpServer()).post("/analyses").send({ repoUrl: REPO_URL });
      const jobId = submitRes.body.jobId as string;

      // Simulates what the future worker processor (task 6.2) will do on
      // success — NOT a real end-to-end pipeline run.
      const scan: RepoScan = await fixture.scores.save({
        repoUrl: REPO_URL,
        commitSha: HEAD_SHA,
        engineVersion: fixture.useCase.engineVersion,
        status: "complete",
        compositeScore: 82,
        completeness: 1,
        dominantLanguage: "TypeScript",
        languageMix: [],
        categories: sixScoredCategories(),
        createdAt: new Date(),
      });
      await fixture.jobs.updateStatus(jobId, "completed", { repoScanId: scan.id });

      const res = await request(fixture.app.getHttpServer()).get(`/analyses/${jobId}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ jobId, status: "completed", cached: false });
      expect(res.body.result.compositeScore).toBe(82);
    });

    it("failed job -> 200 with status 'failed' and no result", async () => {
      fixture = await buildApp();
      const submitRes = await request(fixture.app.getHttpServer()).post("/analyses").send({ repoUrl: REPO_URL });
      const jobId = submitRes.body.jobId as string;

      await fixture.jobs.updateStatus(jobId, "failed");

      const res = await request(fixture.app.getHttpServer()).get(`/analyses/${jobId}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ jobId, status: "failed", cached: false });
      expect(res.body.result).toBeUndefined();
    });

    it("job failed by a scan timeout -> 504 problem+json /errors/scan-timeout with jobId and timeoutMs", async () => {
      fixture = await buildApp();
      const submitRes = await request(fixture.app.getHttpServer()).post("/analyses").send({ repoUrl: REPO_URL });
      const jobId = submitRes.body.jobId as string;

      // Simulates what AnalysisProcessor's describeError() persists when
      // RepoAnalysisService.analyze() rejects with a ScanTimeoutError (see
      // libs/jobs/src/analysis-processor.ts).
      await fixture.jobs.updateStatus(jobId, "failed", {
        errorCode: "ScanTimeoutError",
        errorMessage: "Scan did not complete within 300000ms",
      });

      const res = await request(fixture.app.getHttpServer()).get(`/analyses/${jobId}`);

      expect(res.status).toBe(504);
      expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        type: "/errors/scan-timeout",
        status: 504,
        jobId,
        timeoutMs: 300_000,
      });
    });

    it("job failed by a clone timeout -> 504 problem+json /errors/scan-timeout with jobId and timeoutMs", async () => {
      fixture = await buildApp();
      const submitRes = await request(fixture.app.getHttpServer()).post("/analyses").send({ repoUrl: REPO_URL });
      const jobId = submitRes.body.jobId as string;

      await fixture.jobs.updateStatus(jobId, "failed", {
        errorCode: "CloneTimeoutError",
        errorMessage: "Clone did not complete within 120000ms",
      });

      const res = await request(fixture.app.getHttpServer()).get(`/analyses/${jobId}`);

      expect(res.status).toBe(504);
      expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        type: "/errors/scan-timeout",
        status: 504,
        jobId,
        timeoutMs: 120_000,
      });
    });

    it("job failed for a non-timeout reason (e.g. below-threshold) -> still 200 status 'failed', unchanged", async () => {
      fixture = await buildApp();
      const submitRes = await request(fixture.app.getHttpServer()).post("/analyses").send({ repoUrl: REPO_URL });
      const jobId = submitRes.body.jobId as string;

      await fixture.jobs.updateStatus(jobId, "failed", { errorCode: "BELOW_THRESHOLD" });

      const res = await request(fixture.app.getHttpServer()).get(`/analyses/${jobId}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ jobId, status: "failed", cached: false });
    });
  });
});
