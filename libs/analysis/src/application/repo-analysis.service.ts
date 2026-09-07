import { Inject, Injectable } from "@nestjs/common";
import { AnalysisBelowThresholdError, computeEngineVersion } from "../domain";
import type { IngestionLimits, RepoScan } from "../ports";
import {
  CATEGORY_ANALYZERS,
  REPO_SOURCE_PORT,
  SCORE_REPOSITORY_PORT,
  USAGE_QUOTA_PORT,
  type CategoryAnalyzer,
  type RepoSourcePort,
  type ScoreRepositoryPort,
  type UsageQuotaPort,
} from "../ports";
import { AnalyzerRunner, type AnalyzerProgressCallback } from "./analyzer-runner";
import { ScoreAggregator } from "./score-aggregator";

/**
 * Per spec `analysis-orchestration`: below this many scored categories (of
 * 6), the job fails outright — no RepoScan is persisted and the quota
 * reservation is refunded. At/above it, a 'complete' (6/6) or 'partial'
 * (4-5/6) report is persisted and quota is kept.
 *
 * Why 4, and why this check is rarely the thing that fails a job:
 * only 2 of the 6 categories (Architecture, Documentation) are LLM-judged;
 * the other 4 (Security, Testing, Maintainability, Performance) are
 * deterministic offline heuristics that essentially always produce a score.
 * So `scoredCount` is effectively always >= 4 from the deterministic
 * analyzers alone, and `AnalysisBelowThresholdError` (job `failed` + quota
 * refund via THIS check) is reachable in practice only if 3+ analyzers
 * actually throw. The real production `failed` triggers live elsewhere and
 * are covered by their own tests: `ScanTimeoutError`/`CloneTimeoutError`
 * (-> 504), clone failure, the oversized-repo ingestion gate, and the
 * stale-job watchdog.
 *
 * 4 is a deliberate product bar: a 4/6 report — both qualitative dimensions
 * possibly absent — is still persisted as `partial` because the
 * deterministic measured signal is considered a sufficient backbone.
 * Raising the bar was considered and declined.
 */
const MIN_SCORED_CATEGORIES = 4;

/**
 * Ingestion limits handed to RepoSourcePort.materialize(). Mirrors the
 * design's ephemeral-container numbers (500MB/50k-file ceiling, 600MB
 * per-job volume quota, a 120s clone-wrapper timeout) — real defaults, not
 * placeholders, but a single fixed policy here rather than a configurable
 * port, since no requirement in this batch calls for per-request overrides.
 */
const DEFAULT_INGESTION_LIMITS: IngestionLimits = {
  maxVolumeBytes: 600 * 1024 * 1024,
  maxFiles: 50_000,
  cloneTimeoutMs: 120_000,
};

export interface AnalyzeRepoRequest {
  repoUrl: string;
  actorId: string;
  reservationId: string;
  /**
   * Explicit user "Re-scan": skip the cache lookup below and re-run the
   * full pipeline even when an identical-key scan is already cached. The
   * fresh result is persisted via `ScoreRepositoryPort.saveForced()` (which
   * refreshes the existing complete row in place). Absent/false = current
   * behavior.
   */
  forceRescan?: boolean;
}

/**
 * The use case: resolve -> cache-check -> quota -> materialize+analyze+aggregate
 * -> persist-or-refund. Never touches git, Docker, an LLM, or SQL directly —
 * the four ports are its only outbound edges. See design: "NestJS Wiring".
 *
 * Does NOT own `analysis_job`/`analysis_job_category` row lifecycle (no port
 * exists for that yet — a design gap, not this class's job to paper over).
 * The (not-yet-built) API/worker layer is expected to translate this
 * service's return value / thrown errors into job-table writes and HTTP
 * responses in a later phase.
 */
@Injectable()
export class RepoAnalysisService {
  private readonly runner = new AnalyzerRunner();
  private readonly aggregator = new ScoreAggregator();
  private readonly engineVersion: string;

  constructor(
    @Inject(REPO_SOURCE_PORT) private readonly repoSource: RepoSourcePort,
    @Inject(SCORE_REPOSITORY_PORT) private readonly scores: ScoreRepositoryPort,
    @Inject(USAGE_QUOTA_PORT) private readonly quota: UsageQuotaPort,
    @Inject(CATEGORY_ANALYZERS) private readonly analyzers: readonly CategoryAnalyzer[],
  ) {
    // Shared with apps/api's job-submission use case (Task B, batch
    // 2026-09-04): both map their own analyzer-version source (live
    // instances here; the static ANALYZER_VERSIONS manifest there) to the
    // same {category, analyzerVersion} entry shape and call the SAME pure
    // function — see domain/engine-version.ts's doc comment for why this
    // matters (cache-key parity across the two processes).
    this.engineVersion = computeEngineVersion(
      analyzers.map((a) => ({ category: a.category, analyzerVersion: a.analyzerVersion })),
    );
  }

  /**
   * Throws whatever `RepoSourcePort.resolve/head/materialize` throw (e.g.
   * `InvalidRepoUrlError`, `RepoNotAccessibleError`), `QuotaExceededError`
   * over quota, or `AnalysisBelowThresholdError` when fewer than
   * `MIN_SCORED_CATEGORIES` of 6 categories scored. None of these are
   * swallowed — the caller (a future API/worker layer) maps them onto the
   * right HTTP status / job status.
   */
  async analyze(request: AnalyzeRepoRequest, onProgress?: AnalyzerProgressCallback): Promise<RepoScan> {
    const ref = await this.repoSource.resolve(request.repoUrl);
    const metadata = await this.repoSource.head(ref);

    // forceRescan bypasses the cache lookup entirely — an explicit re-scan
    // must re-run the analyzers even for an unchanged repo. Everything after
    // (quota consume, materialize, analyze, aggregate, threshold) runs
    // identically; only the final persist differs (saveForced vs save).
    if (!request.forceRescan) {
      const cached = await this.scores.findCached({
        repoUrl: ref.url,
        commitSha: metadata.headSha,
        engineVersion: this.engineVersion,
      });
      if (cached) {
        return cached;
      }
    }

    // Quota is consumed before any ingestion or analyzer work starts — per
    // spec `usage-quota`, before any LLM spend is possible, and per test (b),
    // strictly before the first analyzer runs.
    await this.quota.consume(request.actorId, request.reservationId);

    const workspace = await this.repoSource.materialize(ref, metadata.headSha, DEFAULT_INGESTION_LIMITS);
    try {
      const categories = await this.runner.run(this.analyzers, workspace.context, onProgress);
      const report = this.aggregator.aggregate(categories, {
        repoUrl: ref.url,
        commitSha: metadata.headSha,
        engineVersion: this.engineVersion,
        dominantLanguage: workspace.context.dominantLanguage,
        languageMix: workspace.context.languageMix,
      });

      const scoredCount = categories.filter((c) => c.status === "scored").length;
      if (scoredCount < MIN_SCORED_CATEGORIES) {
        await this.quota.refund(request.reservationId);
        throw new AnalysisBelowThresholdError(scoredCount, MIN_SCORED_CATEGORIES, report);
      }

      return await (request.forceRescan
        ? this.scores.saveForced(report)
        : this.scores.save(report));
    } finally {
      await workspace.dispose();
    }
  }
}
