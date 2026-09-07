import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  ANALYZER_VERSIONS,
  HEAD_CALL_RATE_LIMITER_PORT,
  REPO_SOURCE_PORT,
  SCORE_REPOSITORY_PORT,
  USAGE_QUOTA_PORT,
  computeEngineVersion,
  type CategoryId,
  type HeadCallRateLimiterPort,
  type QuotaDecision,
  type RepoScan,
  type RepoSourcePort,
  type ScoreRepositoryPort,
  type UsageQuotaPort,
} from "@cbd/analysis";
import { AnalysisJobRepository } from "@cbd/persistence";
import { AnalysisQueueProducer } from "@cbd/jobs";

/**
 * The API's OWN lightweight job-submission use case (Task C). Deliberately
 * NOT a call into `RepoAnalysisService.analyze()` — that method's
 * constructor needs `CATEGORY_ANALYZERS`/`LLM_JUDGE_PORT`, tokens apps/api
 * never provides (see api.module.ts). This use case only ever calls
 * `RepoSourcePort.resolve()`/`.head()` (cheap, no clone) plus
 * `ScoreRepositoryPort`/`UsageQuotaPort`/job-row-and-queue bookkeeping —
 * never `.materialize()`, never an analyzer, never the LLM judge.
 *
 * Flow: resolve -> head -> cache-check (skipped on forceRescan) ->
 * quota.consume -> create job row -> enqueue -> attach bull job id.
 * See design flow (a)/(b) and spec `analysis-api`/`usage-quota`.
 */

// Narrow, hand-rolled interfaces (not one of the 5 formal hexagonal ports —
// AnalysisJobRepository/AnalysisQueueProducer aren't ports either, see their
// own doc comments) so this use case is testable with plain hand-rolled
// fakes without needing the real classes' private Prisma/BullMQ
// dependencies. The real classes satisfy these structurally; `@Inject()`
// (not reflection) is what actually wires them at runtime — same pattern
// already used for the interface-typed port tokens below.
export interface AnalysisJobCreateInput {
  repoUrl: string;
  commitSha?: string;
  engineVersion: string;
  actorId: string;
  reservationId: string;
}

export interface JobRepositoryPort {
  create(input: AnalysisJobCreateInput): Promise<{ id: string }>;
  attachBullJobId(id: string, bullJobId: string): Promise<void>;
}

export interface QueueProducerPort {
  enqueue(
    analysisJobId: string,
    payload: { repoUrl: string; actorId: string; reservationId: string; forceRescan?: boolean },
  ): Promise<string>;
}

export interface SubmitAnalysisRequest {
  repoUrl: string;
  actorId: string;
  forceRescan?: boolean;
}

export interface SubmitAnalysisQueuedResult {
  outcome: "queued";
  jobId: string;
  commitSha: string;
  pollAfterMs: number;
  quota: QuotaDecision;
}

export interface SubmitAnalysisCachedResult {
  outcome: "cached";
  scanId: string;
  quota: QuotaDecision;
  result: RepoScan;
}

export type SubmitAnalysisResult = SubmitAnalysisQueuedResult | SubmitAnalysisCachedResult;

/** Matches the design's `POST /analyses` 202 example (`pollAfterMs: 2000`). */
const POLL_AFTER_MS = 2000;

@Injectable()
export class SubmitAnalysisUseCase {
  private readonly _engineVersion: string;

  constructor(
    @Inject(REPO_SOURCE_PORT) private readonly repoSource: RepoSourcePort,
    @Inject(SCORE_REPOSITORY_PORT) private readonly scores: ScoreRepositoryPort,
    @Inject(USAGE_QUOTA_PORT) private readonly quota: UsageQuotaPort,
    @Inject(HEAD_CALL_RATE_LIMITER_PORT) private readonly headCallRateLimiter: HeadCallRateLimiterPort,
    @Inject(AnalysisJobRepository) private readonly jobs: JobRepositoryPort,
    @Inject(AnalysisQueueProducer) private readonly queueProducer: QueueProducerPort,
  ) {
    // Task B: computed from the SAME pure function RepoAnalysisService uses,
    // over the static ANALYZER_VERSIONS manifest (@cbd/analysis's
    // domain/analyzer-versions.ts) instead of live analyzer instances — see
    // domain/engine-version.ts and libs/analyzers/src/analyzer-versions.spec.ts
    // (the drift-guard test) for why these are guaranteed to agree.
    this._engineVersion = computeEngineVersion(
      (Object.entries(ANALYZER_VERSIONS) as [CategoryId, string][]).map(([category, analyzerVersion]) => ({
        category,
        analyzerVersion,
      })),
    );
  }

  /** Exposed for tests (seeding a matching cached RepoScan) and for any
   * future debugging/admin surface — not itself part of the HTTP contract. */
  get engineVersion(): string {
    return this._engineVersion;
  }

  /**
   * Throws whatever `RepoSourcePort.resolve()`/`.head()` throw (e.g.
   * `InvalidRepoUrlError`, `RepoNotAccessibleError`, `RepoTooLargeError`),
   * `HeadCallRateLimitExceededError` over the repo-lookup rate limit, or
   * `QuotaExceededError` over the daily analysis quota. None are swallowed
   * — the controller (Task E/F) maps them onto the right HTTP status via
   * the RFC 9457 filter.
   */
  async submit(request: SubmitAnalysisRequest): Promise<SubmitAnalysisResult> {
    const ref = await this.repoSource.resolve(request.repoUrl);
    // Fix C: gates the expensive head() call (spins a real Docker
    // container) BEFORE it's ever invoked — independent of, and checked
    // regardless of, the daily analysis quota below (which isn't reached
    // for a cache hit, and can't safely gate head() itself — see
    // HeadCallRateLimiterPort's own doc comment for why this had to be a
    // separate port rather than moving quota.consume() earlier).
    await this.headCallRateLimiter.checkAndRecord(request.actorId);
    const metadata = await this.repoSource.head(ref);

    if (!request.forceRescan) {
      const cached = await this.scores.findCached({
        repoUrl: ref.url,
        commitSha: metadata.headSha,
        engineVersion: this._engineVersion,
      });
      if (cached) {
        // Design flow (b): cache hit never calls quota.consume().
        const quota = await this.quota.peek(request.actorId);
        return { outcome: "cached", scanId: cached.id, quota, result: cached };
      }
    }

    const reservationId = randomUUID();
    // Quota consumed BEFORE any job row exists — tested explicitly (a
    // QuotaExceededError here must leave zero job rows and zero enqueues).
    await this.quota.consume(request.actorId, reservationId);

    const { id: jobId } = await this.jobs.create({
      repoUrl: ref.url,
      commitSha: metadata.headSha,
      engineVersion: this._engineVersion,
      actorId: request.actorId,
      reservationId,
    });

    const bullJobId = await this.queueProducer.enqueue(jobId, {
      repoUrl: ref.url,
      actorId: request.actorId,
      reservationId,
      // Carried onto the job so the worker's RepoAnalysisService.analyze()
      // skips its own cache check too — this use case already skipped ITS
      // cache check above, but the worker does a second, independent one.
      forceRescan: request.forceRescan === true,
    });
    await this.jobs.attachBullJobId(jobId, bullJobId);

    // peek() AFTER consume() so the reported quota reflects the just-consumed unit.
    const quota = await this.quota.peek(request.actorId);
    return { outcome: "queued", jobId, commitSha: metadata.headSha, pollAfterMs: POLL_AFTER_MS, quota };
  }
}
