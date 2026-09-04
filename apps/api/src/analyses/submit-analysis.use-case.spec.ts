import { describe, expect, it } from "vitest";
import {
  InvalidRepoUrlError,
  QuotaExceededError,
  RepoNotAccessibleError,
  type CategoryScore,
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

class FakeQueueProducer implements QueueProducerPort {
  readonly enqueueCalls: { jobId: string; payload: { repoUrl: string; actorId: string; reservationId: string } }[] =
    [];
  private counter = 0;

  constructor(private readonly order?: string[]) {}

  async enqueue(
    jobId: string,
    payload: { repoUrl: string; actorId: string; reservationId: string },
  ): Promise<string> {
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
    order: string[];
  }> = {},
) {
  const order = overrides.order ?? [];
  const repoSource = overrides.repoSource ?? new FakeRepoSource();
  const scores = overrides.scores ?? new InMemoryScoreRepository();
  const quota = overrides.quota ?? new InMemoryQuota();
  const jobs = new FakeJobRepository(order);
  const queueProducer = new FakeQueueProducer(order);
  const useCase = new SubmitAnalysisUseCase(repoSource, scores, quota, jobs, queueProducer);
  return { useCase, repoSource, scores, quota, jobs, queueProducer, order };
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
    expect(order).toEqual(["jobs.create", "queue.enqueue", "jobs.attachBullJobId"]);
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
});
