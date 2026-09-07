import { Inject, Injectable, Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import {
  RepoAnalysisService,
  USAGE_QUOTA_PORT,
  type AnalyzerProgressCallback,
  type CategoryId,
  type UsageQuotaPort,
} from "@cbd/analysis";
import { AnalysisJobRepository } from "@cbd/persistence";
import { ANALYSIS_QUEUE_NAME } from "./analysis-queue-producer";

/**
 * Shape of a dequeued 'analysis' job's data — `analysisJobId` plus
 * `AnalysisQueueProducer`'s own `EnqueueAnalysisPayload` fields (see
 * `analysis-queue-producer.ts`'s `this.queue.add("analyze", {analysisJobId,
 * ...payload}, ...)`).
 */
export interface AnalysisJobData {
  analysisJobId: string;
  repoUrl: string;
  actorId: string;
  reservationId: string;
  /** Explicit user "Re-scan" — forwarded verbatim to
   * `RepoAnalysisService.analyze()` so the worker skips its own cache
   * lookup. See `EnqueueAnalysisPayload.forceRescan`. */
  forceRescan?: boolean;
}

function describeError(error: unknown): { errorCode: string; errorMessage: string } {
  if (error instanceof Error) {
    return { errorCode: error.name, errorMessage: error.message };
  }
  return { errorCode: "UNKNOWN_ERROR", errorMessage: String(error) };
}

/**
 * AnalysisProcessor — the BullMQ consumer side of the 'analysis' queue
 * (task 6.2). See design "NestJS Wiring": `libs/jobs: JobsConsumerModule -
 * @Processor('analysis') AnalysisProcessor`.
 *
 * Drives `RepoAnalysisService.analyze()` for a dequeued job and translates
 * its outcome (return value or thrown error) onto `analysis_job` /
 * `analysis_job_category` row writes — the bookkeeping
 * `RepoAnalysisService` itself explicitly does NOT own (see its own doc
 * comment: "Does NOT own analysis_job/analysis_job_category row lifecycle").
 *
 * Placement: `libs/jobs`, per the design's literal wiring table — NOT
 * `apps/worker`. Verified this does not introduce a real circular PACKAGE
 * dependency: `libs/jobs` now depends on `@cbd/analysis` (real, for
 * `RepoAnalysisService`/`USAGE_QUOTA_PORT`) and `@cbd/persistence` (real,
 * for `AnalysisJobRepository`). Neither `@cbd/analysis` nor
 * `@cbd/persistence` depends on `@cbd/jobs` — the existing
 * analysis<->persistence cycle (`@cbd/analysis`'s DEVdependency on
 * `@cbd/persistence`, used only by its own contract-style tests) never
 * touches `@cbd/jobs`, so this is a plain fan-in (two new INCOMING edges
 * into `@cbd/jobs`), not a cycle. Confirmed via `pnpm install`: the only
 * "cyclic workspace dependencies" warning it prints is the pre-existing
 * analysis/persistence one — no new one appears after adding these two
 * dependencies.
 *
 * Failure handling (unconditional refund): on ANY thrown error from
 * `analyze()` — including every error class it does NOT already refund
 * internally (everything except `AnalysisBelowThresholdError`, which
 * `RepoAnalysisService` refunds itself before throwing) — this processor
 * marks the job 'failed' and calls `quota.refund()` UNCONDITIONALLY,
 * relying on `UsageQuotaPort.refund()`'s documented idempotency for the one
 * case where a refund already happened. See
 * `analysis-processor.integration.spec.ts`'s materialize()-throws test (the
 * bug this task closes: e.g. `CloneTimeoutError`/`ScanTimeoutError` were
 * NEVER refunded before this processor existed) and its
 * double-refund-is-safe test (driving `AnalysisBelowThresholdError` through
 * the full processor and asserting the quota ends up refunded exactly once
 * IN EFFECT, via `InMemoryQuota.peek()`'s remaining count).
 *
 * BullMQ re-throw-vs-swallow: this processor RE-THROWS after handling a
 * failure (writing the domain-level failure record and refunding FIRST,
 * then re-throwing at the very end). `attempts: 1` on the producer side
 * (see `analysis-queue-producer.ts`) already means BullMQ will never retry
 * a dequeued job, so re-throwing carries no double-execution risk — it only
 * makes BullMQ's own job-state bookkeeping (e.g. what a Bull Board ops
 * dashboard would show) agree with the domain-level
 * `analysis_job.status='failed'` record, instead of BullMQ silently
 * reporting "completed" for a job the domain considers failed.
 */
@Injectable()
@Processor(ANALYSIS_QUEUE_NAME)
export class AnalysisProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalysisProcessor.name);

  constructor(
    // Explicit @Inject() for every param, including the two concrete-class
    // ones — matching this codebase's established convention (see
    // RepoAnalysisService, AnalysesController): ambient
    // `design:paramtypes` reflection for a concrete-class constructor
    // param does not resolve reliably under this repo's Vitest/esbuild
    // transform, confirmed again here via a genuine
    // `Nest can't resolve dependencies of the AnalysisProcessor` RED.
    @Inject(RepoAnalysisService) private readonly repoAnalysisService: RepoAnalysisService,
    @Inject(AnalysisJobRepository) private readonly jobs: AnalysisJobRepository,
    @Inject(USAGE_QUOTA_PORT) private readonly quota: UsageQuotaPort,
  ) {
    super();
  }

  async process(job: Job<AnalysisJobData>): Promise<void> {
    const { analysisJobId, repoUrl, actorId, reservationId, forceRescan } = job.data;

    // AnalyzerRunner's onProgress callback is synchronous — see
    // analyzer-runner.ts, `onProgress?.({...})` is never awaited by the
    // runner itself — so each DB write triggered here is kicked off without
    // blocking the analyzer fan-out. We still track every write's promise
    // and await them ALL below (on both the success and failure path)
    // before setting the job's OWN terminal status: otherwise a slow
    // last-category write could still be in-flight when
    // `analysis_job.status` flips to a terminal value, letting a poller
    // observe a "completed" job with a stale 'pending' category row.
    //
    // Per-category write ORDERING is enforced explicitly via
    // `writeChainByCategory`, not left to arrive-in-order luck: the runner
    // fires 'running' then (once analyze() settles) 'settled' for the same
    // category as two INDEPENDENT, unawaited calls into this callback —
    // without chaining, two independent Postgres UPDATEs issued close
    // together can complete out of order (confirmed via a genuine RED: a
    // fast analyzer's 'settled' write landed before its own slightly
    // slower 'running' write, leaving the row's status stuck at 'running'
    // with 'scored' data already in score/confidence/rationale). Chaining
    // each category's next write onto its own previous write's promise
    // guarantees the 'settled' UPDATE is only ISSUED after the 'running'
    // UPDATE for that same category has actually completed.
    const pendingCategoryWrites: Promise<void>[] = [];
    const writeChainByCategory = new Map<CategoryId, Promise<void>>();
    const onProgress: AnalyzerProgressCallback = (event) => {
      const previous = writeChainByCategory.get(event.category) ?? Promise.resolve();
      const next = previous
        .then(() =>
          event.type === "running"
            ? this.jobs.updateCategoryStatus(analysisJobId, event.category, { status: "running" })
            : this.jobs.updateCategoryStatus(analysisJobId, event.category, {
                status: event.score.status,
                score: event.score.score,
                confidence: event.score.confidence,
                rationale: event.score.rationale,
                findings: event.score.findings,
                errorCode: event.score.error?.code ?? null,
                durationMs: event.score.durationMs,
              }),
        )
        .catch((writeError: unknown) => {
          // A failed progress write must not crash the job — the terminal
          // analysis_job status write below is the authoritative outcome;
          // a missed intermediate category write is a (logged) blemish,
          // not a correctness failure of the job itself.
          this.logger.error(
            `Failed to persist category progress for job ${analysisJobId} (${event.category})`,
            writeError instanceof Error ? writeError.stack : String(writeError),
          );
        });
      writeChainByCategory.set(event.category, next);
      pendingCategoryWrites.push(next);
    };

    try {
      // One coarse in-flight status — RepoAnalysisService.analyze() doesn't
      // expose resolve/clone/scan/aggregate sub-phases, and adding them
      // here would be speculative. Per-CATEGORY progress via onProgress
      // above is the real granular signal this task needs to produce.
      //
      // Deliberately INSIDE the try: this write itself can throw (e.g.
      // updateStatus()'s row UPDATE hitting a transient DB error, or a
      // Prisma P2025 if the row is gone) — it must be covered by the SAME
      // failed+refund handling as every other failure mode below, per this
      // class's own documented "on ANY thrown error" guarantee.
      await this.jobs.updateStatus(analysisJobId, "analyzing");

      const scan = await this.repoAnalysisService.analyze(
        { repoUrl, actorId, reservationId, forceRescan },
        onProgress,
      );
      await Promise.all(pendingCategoryWrites);
      await this.jobs.updateStatus(analysisJobId, scan.status === "complete" ? "completed" : "completed_partial", {
        repoScanId: scan.id,
      });
    } catch (error) {
      await Promise.all(pendingCategoryWrites);
      const { errorCode, errorMessage } = describeError(error);
      try {
        // Refund FIRST, status write SECOND: by the time we're in this
        // catch block, "this job failed, refund unconditionally" is already
        // the decision — there's no conditional/racing logic left gating
        // whether to refund (unlike apps/worker's stale-job-watchdog, whose
        // CAS status write must run first because ITS refund decision
        // depends on the write's own result). Committing the refund before
        // the status write closes the window where a client polling
        // GET /analyses/:id in that exact instant could observe
        // status:'failed' before the refund has actually landed. Relying on
        // refund()'s documented idempotency for the one case where
        // AnalysisBelowThresholdError already refunded internally.
        await this.quota.refund(reservationId);
      } catch (refundError) {
        // Log it but do NOT let it replace/mask the ORIGINAL error being
        // handled, and — the hard requirement — do NOT let it skip the
        // status write below.
        this.logger.error(
          `Failed to refund reservation ${reservationId} for job ${analysisJobId} (original error: ${errorCode}: ${errorMessage})`,
          refundError instanceof Error ? refundError.stack : String(refundError),
        );
      } finally {
        // GUARANTEED to be attempted regardless of whether the refund above
        // succeeded — same non-negotiable guarantee as before the reorder,
        // just with the roles flipped. The status write itself can still
        // throw (e.g. updateStatus()'s row UPDATE hitting a transient DB
        // error); that's logged, not re-thrown, so it never masks the
        // original error either.
        try {
          await this.jobs.updateStatus(analysisJobId, "failed", { errorCode, errorMessage });
        } catch (statusWriteError) {
          this.logger.error(
            `Failed to persist 'failed' status for job ${analysisJobId} (original error: ${errorCode}: ${errorMessage})`,
            statusWriteError instanceof Error ? statusWriteError.stack : String(statusWriteError),
          );
        }
      }
      throw error;
    }
  }
}
