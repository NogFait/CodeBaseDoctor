import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Queue, QueueEvents, Worker } from "bullmq";
import {
  RepoAnalysisService,
  CloneTimeoutError,
  type CategoryAnalyzer,
  type CategoryId,
  type CategoryScore,
  type RepoRef,
  type RepoSourcePort,
  type RepoWorkspace,
  type IngestionLimits,
  type RepoMetadata,
} from "@cbd/analysis";
import { StubAnalyzer } from "@cbd/analysis/testing/stub-analyzer";
import { FixtureRepoSource } from "@cbd/repo-source/testing/fixture-repo-source";
import { InMemoryQuota } from "@cbd/persistence/testing/in-memory-quota";
import { AnalysisJobRepository, PrismaScoreRepository } from "@cbd/persistence";
import { startTestDatabase, type TestDatabase } from "@cbd/persistence/testing/postgres-test-db";
import { AnalysisProcessor, type AnalysisJobData } from "./analysis-processor";
import { AnalysisQueueProducer, ANALYSIS_QUEUE_NAME, type EnqueueAnalysisPayload } from "./analysis-queue-producer";

// Real infra where it matters (mirrors analysis-queue-producer.integration.spec.ts
// and analysis-job-repository.integration.spec.ts): Testcontainers Redis
// backs a REAL bullmq Queue + a REAL bullmq Worker actually dequeuing jobs
// (not a mock of BullMQ's mechanics), and Testcontainers Postgres backs a
// REAL AnalysisJobRepository (real job + category rows). The Worker is
// constructed directly from `bullmq` (not via `@nestjs/bullmq`'s
// `BullModule`/`@Processor` explorer, which only activates on a full Nest
// module bootstrap) and simply delegates each dequeued job to the real
// `AnalysisProcessor.process()` method under test — this exercises the
// exact same dequeue/lock/settle mechanics a Nest-booted worker would use,
// while keeping the test's setup direct (same "construct the real adapter
// directly, skip Nest DI" style already established by
// analysis-queue-producer.integration.spec.ts).
//
// RepoSourcePort/CategoryAnalyzer/UsageQuotaPort are doubles
// (FixtureRepoSource, StubAnalyzer x6, InMemoryQuota) — this suite is
// testing AnalysisProcessor's OWN orchestration/wiring (status
// transitions, category progress writes, unconditional
// refund-on-any-failure), not persistence-adapter or analyzer correctness
// (covered elsewhere).
//
// Deviation from the literal "InMemoryScoreRepository is fine for
// ScoreRepositoryPort" suggestion: ScoreRepositoryPort here is the REAL
// `PrismaScoreRepository` bound to the same Testcontainers Postgres as
// `AnalysisJobRepository`, not `InMemoryScoreRepository`. Reason (found via
// a genuine RED, not a stylistic choice): `analysis_job.repo_scan_id` is a
// real Postgres foreign key into `repo_scan(id)`. `InMemoryScoreRepository`
// mints its own random UUID for a saved scan that only exists in memory —
// the moment `AnalysisProcessor` calls
// `jobs.updateStatus(..., 'completed', {repoScanId})` against the REAL
// `AnalysisJobRepository`, Postgres rejects it with a foreign-key
// violation (`analysis_job_repo_scan_id_fkey`), since no such `repo_scan`
// row exists. Using the real `PrismaScoreRepository` against the same test
// database makes the FK legitimately satisfied — this is still testing
// AnalysisProcessor's wiring, not re-testing PrismaScoreRepository's own
// correctness (that's `prisma-score-repository.integration.spec.ts`'s job).

const FIXTURE_DIR = path.resolve(__dirname, "../../analyzers/__fixtures__/well-tested-ts");
const REPO_URL = "https://github.com/fixture/well-tested-ts";
const ACTOR_ID = "actor-1";
const ALL_CATEGORIES: CategoryId[] = [
  "security",
  "testing",
  "maintainability",
  "architecture",
  "documentation",
  "performance",
];

function scoredResult(category: CategoryId, score = 80): CategoryScore {
  return {
    category,
    status: "scored",
    score,
    confidence: "measured",
    weightCap: category === "performance" ? 0.5 : 1,
    rationale: `${category} looks fine`,
    findings: [],
    durationMs: 5,
  };
}

function allSixAnalyzers(overrides: Partial<Record<CategoryId, "score" | "fail">> = {}): StubAnalyzer[] {
  return ALL_CATEGORIES.map((category) => {
    const mode = overrides[category] ?? "score";
    return mode === "fail"
      ? new StubAnalyzer({ category, error: new Error(`${category} blew up`) })
      : new StubAnalyzer({ category, result: scoredResult(category) });
  });
}

/** Wraps a real RepoSourcePort but forces materialize() to throw — drives
 * the "ingestion fails after quota was already consumed" path, which
 * RepoAnalysisService does NOT refund internally (only
 * AnalysisBelowThresholdError does). This is the exact bug class this
 * whole task exists to close. */
function repoSourceThatFailsToMaterialize(inner: RepoSourcePort, error: Error): RepoSourcePort {
  return {
    resolve: (url: string): Promise<RepoRef> => inner.resolve(url),
    head: (ref: RepoRef): Promise<RepoMetadata> => inner.head(ref),
    materialize: (_ref: RepoRef, _sha: string, _limits: IngestionLimits): Promise<RepoWorkspace> => {
      throw error;
    },
  };
}

describe("AnalysisProcessor (Testcontainers Redis + Postgres)", () => {
  let redisContainer: StartedRedisContainer;
  let db: TestDatabase;
  let queue: Queue;
  let queueEvents: QueueEvents;
  let producer: AnalysisQueueProducer;
  let jobsRepo: AnalysisJobRepository;
  let worker: Worker | undefined;

  beforeAll(async () => {
    redisContainer = await new RedisContainer("redis:7-alpine").start();
    db = await startTestDatabase();
    const connection = { host: redisContainer.getHost(), port: redisContainer.getMappedPort(6379) };
    queue = new Queue(ANALYSIS_QUEUE_NAME, { connection });
    queueEvents = new QueueEvents(ANALYSIS_QUEUE_NAME, { connection });
    await queueEvents.waitUntilReady();
    producer = new AnalysisQueueProducer(queue);
    jobsRepo = new AnalysisJobRepository(db.prisma);
  }, 60_000);

  afterAll(async () => {
    await queueEvents.close();
    await queue.close();
    await db.stop();
    await redisContainer.stop();
  });

  afterEach(async () => {
    if (worker) {
      await worker.close();
      worker = undefined;
    }
    await queue.obliterate({ force: true });
    // analysis_job first (its own FK into repo_scan must be gone before
    // repo_scan itself is truncated), then repo_scan — otherwise a later
    // test's findCached() could get a false cache hit off a previous
    // test's leftover scan (same fixture repoUrl/commitSha/engineVersion
    // across tests using allSixAnalyzers()).
    await db.prisma.$executeRaw`TRUNCATE TABLE analysis_job CASCADE`;
    await db.prisma.$executeRaw`TRUNCATE TABLE repo_scan CASCADE`;
    vi.restoreAllMocks();
  });

  /** Starts a real bullmq Worker delegating to `processor.process()`, waits
   * until it's ready, enqueues via the real AnalysisQueueProducer, and
   * returns the resulting real bullmq Job handle. */
  async function runJob(
    processor: AnalysisProcessor,
    analysisJobId: string,
    payload: EnqueueAnalysisPayload,
  ) {
    const connection = { host: redisContainer.getHost(), port: redisContainer.getMappedPort(6379) };
    worker = new Worker<AnalysisJobData>(ANALYSIS_QUEUE_NAME, (job) => processor.process(job), {
      connection,
      concurrency: 1,
    });
    await worker.waitUntilReady();

    const bullJobId = await producer.enqueue(analysisJobId, payload);
    const bullJob = await queue.getJob(bullJobId);
    if (!bullJob) throw new Error("test setup: job not found immediately after enqueue");
    return bullJob;
  }

  it("(happy path) 6/6 analyzers succeed -> job completed, all 6 categories scored, quota kept", async () => {
    const reservationId = randomUUID();
    const quota = new InMemoryQuota({ limit: 5 });
    const service = new RepoAnalysisService(
      new FixtureRepoSource(FIXTURE_DIR, REPO_URL),
      new PrismaScoreRepository(db.prisma),
      quota,
      allSixAnalyzers(),
    );
    const processor = new AnalysisProcessor(service, jobsRepo, quota);
    const { id: analysisJobId } = await jobsRepo.create({
      repoUrl: REPO_URL,
      engineVersion: "test-engine",
      actorId: ACTOR_ID,
      reservationId,
    });

    const bullJob = await runJob(processor, analysisJobId, { repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId });
    await bullJob.waitUntilFinished(queueEvents, 30_000);

    const record = await jobsRepo.findById(analysisJobId);
    expect(record?.status).toBe("completed");
    expect(record?.categories).toHaveLength(6);
    expect(record?.categories.every((c) => c.status === "scored")).toBe(true);
    expect(record?.repoScanId).not.toBeNull();
    expect(quota.refundCalls).toHaveLength(0);
  });

  it("(partial) exactly 1 analyzer throws -> job completed_partial, the failing category recorded, quota kept", async () => {
    const reservationId = randomUUID();
    const quota = new InMemoryQuota({ limit: 5 });
    const service = new RepoAnalysisService(
      new FixtureRepoSource(FIXTURE_DIR, REPO_URL),
      new PrismaScoreRepository(db.prisma),
      quota,
      allSixAnalyzers({ architecture: "fail" }),
    );
    const processor = new AnalysisProcessor(service, jobsRepo, quota);
    const { id: analysisJobId } = await jobsRepo.create({
      repoUrl: REPO_URL,
      engineVersion: "test-engine",
      actorId: ACTOR_ID,
      reservationId,
    });

    const bullJob = await runJob(processor, analysisJobId, { repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId });
    await bullJob.waitUntilFinished(queueEvents, 30_000);

    const record = await jobsRepo.findById(analysisJobId);
    expect(record?.status).toBe("completed_partial");
    const scored = record?.categories.filter((c) => c.status === "scored") ?? [];
    const failed = record?.categories.filter((c) => c.status === "failed") ?? [];
    expect(scored).toHaveLength(5);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.category).toBe("architecture");
    expect(failed[0]?.errorCode).toBe("ANALYZER_ERROR");
    expect(quota.refundCalls).toHaveLength(0);
  });

  it("(below threshold) 3+ analyzers throw -> job failed, quota refunded exactly once IN EFFECT (double-refund is safe)", async () => {
    const reservationId = randomUUID();
    const quota = new InMemoryQuota({ limit: 5 });
    const service = new RepoAnalysisService(
      new FixtureRepoSource(FIXTURE_DIR, REPO_URL),
      new PrismaScoreRepository(db.prisma),
      quota,
      allSixAnalyzers({ architecture: "fail", documentation: "fail", performance: "fail" }),
    );
    const processor = new AnalysisProcessor(service, jobsRepo, quota);
    const { id: analysisJobId } = await jobsRepo.create({
      repoUrl: REPO_URL,
      engineVersion: "test-engine",
      actorId: ACTOR_ID,
      reservationId,
    });

    const bullJob = await runJob(processor, analysisJobId, { repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId });

    // RepoAnalysisService.analyze() itself already refunds once (per its
    // own AnalysisBelowThresholdError path) BEFORE this processor's own
    // catch-all refunds again — this is the "double refund" being tested.
    await expect(bullJob.waitUntilFinished(queueEvents, 30_000)).rejects.toThrow();

    const record = await jobsRepo.findById(analysisJobId);
    expect(record?.status).toBe("failed");
    expect(record?.errorCode).toBe("AnalysisBelowThresholdError");
    const scored = record?.categories.filter((c) => c.status === "scored") ?? [];
    expect(scored).toHaveLength(3);

    // Assert the EFFECT of idempotent refund (not raw refund() call count):
    // the actor's quota reads as if the reservation was never consumed.
    const decision = await quota.peek(ACTOR_ID);
    expect(decision.remaining).toBe(5);
  });

  it("(materialize() throws) CloneTimeoutError after quota already consumed -> job failed AND refunded — the bug this task closes", async () => {
    const reservationId = randomUUID();
    const quota = new InMemoryQuota({ limit: 5 });
    const throwingRepoSource = repoSourceThatFailsToMaterialize(
      new FixtureRepoSource(FIXTURE_DIR, REPO_URL),
      new CloneTimeoutError(120_000),
    );
    const service = new RepoAnalysisService(
      throwingRepoSource,
      new PrismaScoreRepository(db.prisma),
      quota,
      allSixAnalyzers(), // never reached — materialize() throws before the fan-out
    );
    const processor = new AnalysisProcessor(service, jobsRepo, quota);
    const { id: analysisJobId } = await jobsRepo.create({
      repoUrl: REPO_URL,
      engineVersion: "test-engine",
      actorId: ACTOR_ID,
      reservationId,
    });

    const bullJob = await runJob(processor, analysisJobId, { repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId });
    await expect(bullJob.waitUntilFinished(queueEvents, 30_000)).rejects.toThrow();

    const record = await jobsRepo.findById(analysisJobId);
    expect(record?.status).toBe("failed");
    expect(record?.errorCode).toBe("CloneTimeoutError");

    // Before this task, NOTHING refunded this reservation: materialize()
    // throwing is not AnalysisBelowThresholdError, so RepoAnalysisService's
    // own internal refund never fires for it. The processor's UNCONDITIONAL
    // catch-all refund is what makes this pass.
    expect(quota.refundCalls).toContain(reservationId);
    const decision = await quota.peek(ACTOR_ID);
    expect(decision.remaining).toBe(5);
  });

  it("(bug fix: initial status write outside try/catch) the initial 'analyzing' status write throwing still results in the job marked failed and quota refunded", async () => {
    const reservationId = randomUUID();
    const quota = new InMemoryQuota({ limit: 5 });
    const service = new RepoAnalysisService(
      new FixtureRepoSource(FIXTURE_DIR, REPO_URL),
      new PrismaScoreRepository(db.prisma),
      quota,
      allSixAnalyzers(),
    );
    const processor = new AnalysisProcessor(service, jobsRepo, quota);
    const { id: analysisJobId } = await jobsRepo.create({
      repoUrl: REPO_URL,
      engineVersion: "test-engine",
      actorId: ACTOR_ID,
      reservationId,
    });

    // Fail only the FIRST updateStatus() call (the initial 'analyzing'
    // write) — every subsequent call (including the catch block's 'failed'
    // write) uses the real implementation.
    vi.spyOn(jobsRepo, "updateStatus").mockImplementationOnce(async () => {
      throw new Error("simulated transient DB error on initial status write");
    });

    const bullJob = await runJob(processor, analysisJobId, { repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId });
    await expect(bullJob.waitUntilFinished(queueEvents, 30_000)).rejects.toThrow();

    const record = await jobsRepo.findById(analysisJobId);
    expect(record?.status).toBe("failed");
    expect(quota.refundCalls).toContain(reservationId);
    const decision = await quota.peek(ACTOR_ID);
    expect(decision.remaining).toBe(5);
  });

  it("(bug fix: refund not guarded by try/finally) the failure-path 'failed' status write throwing still refunds the quota", async () => {
    const reservationId = randomUUID();
    const quota = new InMemoryQuota({ limit: 5 });
    const throwingRepoSource = repoSourceThatFailsToMaterialize(
      new FixtureRepoSource(FIXTURE_DIR, REPO_URL),
      new CloneTimeoutError(120_000),
    );
    const service = new RepoAnalysisService(
      throwingRepoSource,
      new PrismaScoreRepository(db.prisma),
      quota,
      allSixAnalyzers(), // never reached — materialize() throws before the fan-out
    );
    const processor = new AnalysisProcessor(service, jobsRepo, quota);
    const { id: analysisJobId } = await jobsRepo.create({
      repoUrl: REPO_URL,
      engineVersion: "test-engine",
      actorId: ACTOR_ID,
      reservationId,
    });

    // Call #1 is the initial 'analyzing' write (must succeed for real, so
    // analyze() actually runs and throws CloneTimeoutError). Call #2 is the
    // catch block's 'failed' write — fail exactly that one to prove refund
    // isn't gated behind it succeeding.
    const originalUpdateStatus = jobsRepo.updateStatus.bind(jobsRepo);
    let calls = 0;
    vi.spyOn(jobsRepo, "updateStatus").mockImplementation(async (id, status, extra) => {
      calls += 1;
      if (calls === 2) {
        throw new Error("simulated transient DB error on failure-path status write");
      }
      return originalUpdateStatus(id, status, extra);
    });

    const bullJob = await runJob(processor, analysisJobId, { repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId });
    await expect(bullJob.waitUntilFinished(queueEvents, 30_000)).rejects.toThrow();

    // The 'failed' status write itself failed, so the row legitimately
    // never reached 'failed' here — the hard, non-negotiable requirement is
    // the refund, which must NOT be gated behind that write succeeding.
    expect(quota.refundCalls).toContain(reservationId);
    const decision = await quota.peek(ACTOR_ID);
    expect(decision.remaining).toBe(5);
  });

  it("(refund-before-status-write ordering) the catch block commits the refund BEFORE writing the 'failed' status, not after", async () => {
    const reservationId = randomUUID();
    const quota = new InMemoryQuota({ limit: 5 });
    const throwingRepoSource = repoSourceThatFailsToMaterialize(
      new FixtureRepoSource(FIXTURE_DIR, REPO_URL),
      new CloneTimeoutError(120_000),
    );
    const service = new RepoAnalysisService(
      throwingRepoSource,
      new PrismaScoreRepository(db.prisma),
      quota,
      allSixAnalyzers(), // never reached — materialize() throws before the fan-out
    );
    const processor = new AnalysisProcessor(service, jobsRepo, quota);
    const { id: analysisJobId } = await jobsRepo.create({
      repoUrl: REPO_URL,
      engineVersion: "test-engine",
      actorId: ACTOR_ID,
      reservationId,
    });

    // Record the order in which the catch block's two side effects fire.
    // Call #1 of updateStatus is the initial 'analyzing' write (real, not
    // tracked) — only the catch block's 'failed' write (call #2) matters
    // here.
    const callOrder: string[] = [];
    const originalUpdateStatus = jobsRepo.updateStatus.bind(jobsRepo);
    let updateStatusCalls = 0;
    vi.spyOn(jobsRepo, "updateStatus").mockImplementation(async (id, status, extra) => {
      updateStatusCalls += 1;
      if (updateStatusCalls === 2) callOrder.push("status-write");
      return originalUpdateStatus(id, status, extra);
    });
    const originalRefund = quota.refund.bind(quota);
    vi.spyOn(quota, "refund").mockImplementation(async (resId) => {
      callOrder.push("refund");
      return originalRefund(resId);
    });

    const bullJob = await runJob(processor, analysisJobId, { repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId });
    await expect(bullJob.waitUntilFinished(queueEvents, 30_000)).rejects.toThrow();

    // The refund must commit BEFORE the 'failed' status write is issued —
    // closes the window where a polling client could observe
    // status:'failed' while the refund hasn't landed yet.
    expect(callOrder).toEqual(["refund", "status-write"]);

    const record = await jobsRepo.findById(analysisJobId);
    expect(record?.status).toBe("failed");
    expect(quota.refundCalls).toContain(reservationId);
  });

  it("(refund-before-status-write ordering) refund still commits even when the subsequent 'failed' status write throws", async () => {
    const reservationId = randomUUID();
    const quota = new InMemoryQuota({ limit: 5 });
    const throwingRepoSource = repoSourceThatFailsToMaterialize(
      new FixtureRepoSource(FIXTURE_DIR, REPO_URL),
      new CloneTimeoutError(120_000),
    );
    const service = new RepoAnalysisService(
      throwingRepoSource,
      new PrismaScoreRepository(db.prisma),
      quota,
      allSixAnalyzers(), // never reached — materialize() throws before the fan-out
    );
    const processor = new AnalysisProcessor(service, jobsRepo, quota);
    const { id: analysisJobId } = await jobsRepo.create({
      repoUrl: REPO_URL,
      engineVersion: "test-engine",
      actorId: ACTOR_ID,
      reservationId,
    });

    // Call #1 is the initial 'analyzing' write (must succeed for real, so
    // analyze() actually runs and throws CloneTimeoutError). Call #2 is the
    // catch block's 'failed' write — fail it to prove the refund (which
    // must now run BEFORE this write is even attempted) is wholly
    // unaffected by this write throwing.
    const originalUpdateStatus = jobsRepo.updateStatus.bind(jobsRepo);
    let updateStatusCalls = 0;
    vi.spyOn(jobsRepo, "updateStatus").mockImplementation(async (id, status, extra) => {
      updateStatusCalls += 1;
      if (updateStatusCalls === 2) {
        throw new Error("simulated transient DB error on failure-path status write");
      }
      return originalUpdateStatus(id, status, extra);
    });

    const bullJob = await runJob(processor, analysisJobId, { repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId });
    await expect(bullJob.waitUntilFinished(queueEvents, 30_000)).rejects.toThrow();

    // The refund is not gated behind the status write succeeding — same
    // hard requirement as before the reorder, just with the order flipped.
    expect(quota.refundCalls).toContain(reservationId);
    const decision = await quota.peek(ACTOR_ID);
    expect(decision.remaining).toBe(5);
  });

  it("(per-category live progress) observes a 'running' transition before the terminal status for a given category", async () => {
    const reservationId = randomUUID();
    const quota = new InMemoryQuota({ limit: 5 });
    const service = new RepoAnalysisService(
      new FixtureRepoSource(FIXTURE_DIR, REPO_URL),
      new PrismaScoreRepository(db.prisma),
      quota,
      allSixAnalyzers(),
    );
    const spy = vi.spyOn(jobsRepo, "updateCategoryStatus");
    const processor = new AnalysisProcessor(service, jobsRepo, quota);
    const { id: analysisJobId } = await jobsRepo.create({
      repoUrl: REPO_URL,
      engineVersion: "test-engine",
      actorId: ACTOR_ID,
      reservationId,
    });

    const bullJob = await runJob(processor, analysisJobId, { repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId });
    await bullJob.waitUntilFinished(queueEvents, 30_000);

    const securityCalls = spy.mock.calls.filter(([jobId, category]) => jobId === analysisJobId && category === "security");
    expect(securityCalls.length).toBeGreaterThanOrEqual(2);
    expect(securityCalls[0]?.[2]).toMatchObject({ status: "running" });
    expect(securityCalls[securityCalls.length - 1]?.[2]).toMatchObject({ status: "scored" });
  });

  it("marks the job 'analyzing' immediately, before the terminal status is reached", async () => {
    const reservationId = randomUUID();
    const quota = new InMemoryQuota({ limit: 5 });
    // A slow analyzer keeps the job in-flight long enough to observe the
    // intermediate 'analyzing' status without racing a fast StubAnalyzer.
    const slowAnalyzer: CategoryAnalyzer = {
      category: "security",
      confidence: "measured",
      analyzerVersion: "stub-1.0.0",
      analyze: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return scoredResult("security");
      },
    };
    const analyzers = allSixAnalyzers().map((a) => (a.category === "security" ? slowAnalyzer : a));
    const service = new RepoAnalysisService(
      new FixtureRepoSource(FIXTURE_DIR, REPO_URL),
      new PrismaScoreRepository(db.prisma),
      quota,
      analyzers,
    );
    const processor = new AnalysisProcessor(service, jobsRepo, quota);
    const { id: analysisJobId } = await jobsRepo.create({
      repoUrl: REPO_URL,
      engineVersion: "test-engine",
      actorId: ACTOR_ID,
      reservationId,
    });

    const bullJob = await runJob(processor, analysisJobId, { repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId });

    // Race an early read against completion: the job should already be
    // 'analyzing' well before the slow analyzer settles.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const midFlight = await jobsRepo.findById(analysisJobId);
    expect(midFlight?.status).toBe("analyzing");

    await bullJob.waitUntilFinished(queueEvents, 30_000);
    const final = await jobsRepo.findById(analysisJobId);
    expect(final?.status).toBe("completed");
  });
});
