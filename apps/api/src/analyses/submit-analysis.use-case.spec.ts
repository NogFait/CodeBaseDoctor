import { describe, expect, it } from "vitest";
import {
  HeadCallRateLimitExceededError,
  InvalidRepoUrlError,
  QuotaExceededError,
  RepoNotAccessibleError,
  type CategoryScore,
  type HeadCallRateLimiterPort,
  type IngestionLimits,
  type RepoMetadata,
  type RepoRef,
  type RepoScoreReport,
  type RepoSourcePort,
  type RepoWorkspace,
} from "@cbd/analysis";
import { InMemoryScoreRepository } from "@cbd/persistence/testing/in-memory-score-repository";
import { InMemoryQuota } from "@cbd/persistence/testing/in-memory-quota";
import type { AnalysisJobCreateInput, JobRepositoryPort, QueueProducerPort } from "./submit-analysis.use-case";
import { SubmitAnalysisUseCase } from "./submit-analysis.use-case";

const REPO_URL = "https://github.com/fixture/well-tested-ts";
const HEAD_SHA = "a".repeat(40);
const ACTOR_ID = "actor-1";

/** Configurable RepoSourcePort test double — resolve()/head() only ever
 * need to be controlled here; the use case must NEVER call materialize(). */
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
    throw new Error("SubmitAnalysisUseCase must never call materialize() — that is the worker's job");
  }
}

/** Configurable HeadCallRateLimiterPort test double (Fix C) — default
 * allows every attempt, overridable via checkAndRecordImpl to simulate the
 * limit being exceeded. `order` is optional call-order tracking, same
 * pattern as FakeJobRepository/FakeQueueProducer below. */
class FakeHeadCallRateLimiter implements HeadCallRateLimiterPort {
  checkAndRecordImpl: (actorId: string) => Promise<void> = async () => {};
  readonly calls: string[] = [];

  constructor(private readonly order?: string[]) {}

  async checkAndRecord(actorId: string): Promise<void> {
    this.order?.push("headCallRateLimiter.checkAndRecord");
    this.calls.push(actorId);
    return this.checkAndRecordImpl(actorId);
  }
}

class FakeJobRepository implements JobRepositoryPort {
  readonly createCalls: AnalysisJobCreateInput[] = [];
  readonly attachBullJobIdCalls: { id: string; bullJobId: string }[] = [];
  private counter = 0;

  constructor(private readonly order?: string[]) {}

  async create(input: AnalysisJobCreateInput): Promise<{ id: string }> {
    this.order?.push("jobs.create");
    this.createCalls.push(input);
    return { id: `job-${++this.counter}` };
  }

  async attachBullJobId(id: string, bullJobId: string): Promise<void> {
    this.order?.push("jobs.attachBullJobId");
    this.attachBullJobIdCalls.push({ id, bullJobId });
  }
}

type EnqueuePayload = { repoUrl: string; actorId: string; reservationId: string; forceRescan?: boolean };

class FakeQueueProducer implements QueueProducerPort {
  readonly enqueueCalls: { jobId: string; payload: EnqueuePayload }[] = [];
  private counter = 0;

  constructor(private readonly order?: string[]) {}

  async enqueue(jobId: string, payload: EnqueuePayload): Promise<string> {
    this.order?.push("queue.enqueue");
    this.enqueueCalls.push({ jobId, payload });
    return `bull-${++this.counter}`;
  }
}

function sixScoredCategories(): CategoryScore[] {
  const categories: CategoryScore["category"][] = [
    "security",
    "testing",
    "maintainability",
    "architecture",
    "documentation",
    "performance",
  ];
  return categories.map((category) => ({
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

function buildUseCase(
  overrides: Partial<{
    repoSource: FakeRepoSource;
    scores: InMemoryScoreRepository;
    quota: InMemoryQuota;
    headCallRateLimiter: FakeHeadCallRateLimiter;
    order: string[];
  }> = {},
) {
  const order = overrides.order ?? [];
  const repoSource = overrides.repoSource ?? new FakeRepoSource();
  const scores = overrides.scores ?? new InMemoryScoreRepository();
  const quota = overrides.quota ?? new InMemoryQuota();
  const headCallRateLimiter = overrides.headCallRateLimiter ?? new FakeHeadCallRateLimiter(order);
  const jobs = new FakeJobRepository(order);
  const queueProducer = new FakeQueueProducer(order);
  const useCase = new SubmitAnalysisUseCase(repoSource, scores, quota, headCallRateLimiter, jobs, queueProducer);
  return { useCase, repoSource, scores, quota, headCallRateLimiter, jobs, queueProducer, order };
}

async function seedCachedScan(scores: InMemoryScoreRepository, engineVersion: string): Promise<RepoScoreReport> {
  const report: RepoScoreReport = {
    repoUrl: REPO_URL,
    commitSha: HEAD_SHA,
    engineVersion,
    status: "complete",
    compositeScore: 80,
    completeness: 1,
    dominantLanguage: "TypeScript",
    languageMix: [],
    categories: sixScoredCategories(),
    createdAt: new Date(),
  };
  await scores.save(report);
  return report;
}

describe("SubmitAnalysisUseCase", () => {
  it("cache hit: returns the cached result, consumes no quota, creates no job, enqueues nothing", async () => {
    const { useCase, scores, quota, jobs, queueProducer } = buildUseCase();
    await seedCachedScan(scores, useCase.engineVersion);

    const result = await useCase.submit({ repoUrl: REPO_URL, actorId: ACTOR_ID });

    expect(result.outcome).toBe("cached");
    expect(quota.consumeCalls).toHaveLength(0);
    expect(jobs.createCalls).toHaveLength(0);
    expect(queueProducer.enqueueCalls).toHaveLength(0);
  });

  it("quota exceeded: propagates QuotaExceededError; no job row is ever created and nothing is enqueued", async () => {
    const { useCase, jobs, queueProducer } = buildUseCase({ quota: new InMemoryQuota({ limit: 0 }) });

    await expect(useCase.submit({ repoUrl: REPO_URL, actorId: ACTOR_ID })).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    expect(jobs.createCalls).toHaveLength(0);
    expect(queueProducer.enqueueCalls).toHaveLength(0);
  });

  it("happy path (cache miss): creates the job row, THEN enqueues, THEN attaches the bull job id, in that order", async () => {
    const order: string[] = [];
    const { useCase, jobs, queueProducer } = buildUseCase({ order });

    const result = await useCase.submit({ repoUrl: REPO_URL, actorId: ACTOR_ID });

    expect(result.outcome).toBe("queued");
    // Fix C added a head-call rate-limiter check ahead of everything else
    // in the flow (see the dedicated "checks the head-call rate limiter…"
    // test below for that ordering specifically) — this test's own concern
    // is unchanged: job creation, THEN enqueue, THEN attach, in that order.
    expect(order).toEqual([
      "headCallRateLimiter.checkAndRecord",
      "jobs.create",
      "queue.enqueue",
      "jobs.attachBullJobId",
    ]);
    expect(jobs.createCalls).toHaveLength(1);
    expect(jobs.createCalls[0]).toMatchObject({
      repoUrl: REPO_URL,
      commitSha: HEAD_SHA,
      actorId: ACTOR_ID,
      engineVersion: useCase.engineVersion,
    });
    expect(queueProducer.enqueueCalls).toHaveLength(1);
    expect(queueProducer.enqueueCalls[0].payload.reservationId).toBe(jobs.createCalls[0].reservationId);
    expect(jobs.attachBullJobIdCalls).toHaveLength(1);
    expect(jobs.attachBullJobIdCalls[0].bullJobId).toBe("bull-1");
  });

  it("InvalidRepoUrlError from resolve() propagates untouched", async () => {
    const { useCase, repoSource } = buildUseCase();
    repoSource.resolveImpl = async () => {
      throw new InvalidRepoUrlError("not-a-url");
    };

    await expect(useCase.submit({ repoUrl: "not-a-url", actorId: ACTOR_ID })).rejects.toBeInstanceOf(
      InvalidRepoUrlError,
    );
  });

  it("RepoNotAccessibleError from head() propagates untouched", async () => {
    const { useCase, repoSource } = buildUseCase();
    repoSource.headImpl = async () => {
      throw new RepoNotAccessibleError(REPO_URL, "private");
    };

    await expect(useCase.submit({ repoUrl: REPO_URL, actorId: ACTOR_ID })).rejects.toBeInstanceOf(
      RepoNotAccessibleError,
    );
  });

  it("forceRescan:true bypasses an existing cache hit and enqueues a fresh job", async () => {
    const { useCase, scores, jobs, queueProducer } = buildUseCase();
    await seedCachedScan(scores, useCase.engineVersion);

    const result = await useCase.submit({ repoUrl: REPO_URL, actorId: ACTOR_ID, forceRescan: true });

    expect(result.outcome).toBe("queued");
    expect(jobs.createCalls).toHaveLength(1);
    expect(queueProducer.enqueueCalls).toHaveLength(1);
  });

  it("forceRescan:true is carried on the ENQUEUED job payload, so the worker skips its own cache check too", async () => {
    const { useCase, scores, queueProducer } = buildUseCase();
    await seedCachedScan(scores, useCase.engineVersion);

    await useCase.submit({ repoUrl: REPO_URL, actorId: ACTOR_ID, forceRescan: true });

    expect(queueProducer.enqueueCalls).toHaveLength(1);
    expect(queueProducer.enqueueCalls[0].payload).toMatchObject({ forceRescan: true });
  });

  it("a normal (non-forced) submission does NOT put forceRescan:true on the enqueued payload", async () => {
    const { useCase, queueProducer } = buildUseCase();

    await useCase.submit({ repoUrl: REPO_URL, actorId: ACTOR_ID });

    expect(queueProducer.enqueueCalls).toHaveLength(1);
    expect(queueProducer.enqueueCalls[0].payload.forceRescan).toBeFalsy();
  });

  // --- Fix C: head-call rate limiter (independent of the daily analysis
  // quota) ---------------------------------------------------------------

  it("checks the head-call rate limiter for actorId, AFTER resolve() and BEFORE head()", async () => {
    const callOrder: string[] = [];
    const { useCase, repoSource, headCallRateLimiter } = buildUseCase();
    const originalResolve = repoSource.resolveImpl;
    repoSource.resolveImpl = async (url) => {
      callOrder.push("repoSource.resolve");
      return originalResolve(url);
    };
    const originalHead = repoSource.headImpl;
    repoSource.headImpl = async (ref) => {
      callOrder.push("repoSource.head");
      return originalHead(ref);
    };
    headCallRateLimiter.checkAndRecordImpl = async () => {
      callOrder.push("headCallRateLimiter.checkAndRecord");
    };

    await useCase.submit({ repoUrl: REPO_URL, actorId: ACTOR_ID });

    expect(callOrder).toEqual(["repoSource.resolve", "headCallRateLimiter.checkAndRecord", "repoSource.head"]);
    expect(headCallRateLimiter.calls).toEqual([ACTOR_ID]);
  });

  it("head-call rate limit exceeded: propagates HeadCallRateLimitExceededError; head() and quota.consume() are never reached", async () => {
    const { useCase, repoSource, quota, headCallRateLimiter } = buildUseCase();
    let headCalls = 0;
    const originalHead = repoSource.headImpl;
    repoSource.headImpl = async (ref) => {
      headCalls += 1;
      return originalHead(ref);
    };
    headCallRateLimiter.checkAndRecordImpl = async (actorId) => {
      throw new HeadCallRateLimitExceededError(actorId, 20, new Date());
    };

    await expect(useCase.submit({ repoUrl: REPO_URL, actorId: ACTOR_ID })).rejects.toBeInstanceOf(
      HeadCallRateLimitExceededError,
    );
    expect(headCalls).toBe(0);
    expect(quota.consumeCalls).toHaveLength(0);
  });

  it("cache hit: consumes no quota (unchanged by Fix C) — the head-call rate limiter is still checked, but is a separate gate", async () => {
    const { useCase, scores, quota, headCallRateLimiter } = buildUseCase();
    await seedCachedScan(scores, useCase.engineVersion);

    const result = await useCase.submit({ repoUrl: REPO_URL, actorId: ACTOR_ID });

    expect(result.outcome).toBe("cached");
    expect(quota.consumeCalls).toHaveLength(0);
    // The rate limiter itself still runs (it gates head(), not the cache
    // check) — but this is the pre-existing "cache hit consumes no quota"
    // guarantee (capability 06), which this fix must never touch.
    expect(headCallRateLimiter.calls).toEqual([ACTOR_ID]);
  });

  it("cache hit under exhausted daily quota still succeeds (capability 06) — unaffected by the new, independent rate limiter", async () => {
    const { useCase, scores, quota } = buildUseCase({ quota: new InMemoryQuota({ limit: 0 }) });
    await seedCachedScan(scores, useCase.engineVersion);

    const result = await useCase.submit({ repoUrl: REPO_URL, actorId: ACTOR_ID });

    expect(result.outcome).toBe("cached");
    expect(quota.consumeCalls).toHaveLength(0);
  });
});
