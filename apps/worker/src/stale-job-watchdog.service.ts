import { Inject, Injectable, Logger } from "@nestjs/common";
import { USAGE_QUOTA_PORT, type UsageQuotaPort } from "@cbd/analysis";
import { AnalysisJobRepository } from "@cbd/persistence";

/** 15 minutes — see design: "Timeouts are layered ... an `analysis_job`
 * watchdog that marks anything `started_at < now() - 15min` as `failed`." */
export const STALE_JOB_TIMEOUT_MS = 15 * 60 * 1000;

/** Distinct from any error code `AnalysisProcessor` itself ever writes
 * (which are always an `Error.prototype.name`, e.g. `CloneTimeoutError`,
 * `AnalysisBelowThresholdError`) — this code specifically means "no
 * processor was left alive to report a real error", not "a real error was
 * caught". */
export const STALE_JOB_WATCHDOG_ERROR_CODE = "JOB_WATCHDOG_TIMEOUT";

/**
 * StaleJobWatchdogService — task 6.3's last piece. Marks jobs that started
 * (`startedAt` set, via `AnalysisJobRepository.updateStatus()`'s
 * first-move-away-from-'queued' rule) but never reached a terminal status
 * within `STALE_JOB_TIMEOUT_MS` as 'failed', refunding their quota
 * reservation. Covers the case a worker process crashes or is killed
 * mid-job, leaving a row stuck 'analyzing'/'cloning'/etc. forever with no
 * `AnalysisProcessor` left alive to ever mark it failed itself (the
 * unconditional-refund-on-any-failure guarantee in
 * `AnalysisProcessor.process()`'s own catch block only fires if that
 * process is still running to catch anything).
 *
 * Deliberately worker-only (`apps/worker/src`, not a shared lib) — sweeping
 * stuck jobs is a worker-process housekeeping concern; apps/api never needs
 * it.
 *
 * Separated from scheduling on purpose: `sweep()` is the entire policy,
 * independently testable against a real database with a genuinely
 * backdated row (see `stale-job-watchdog.service.integration.spec.ts`).
 * `StaleJobWatchdogScheduler` is the thin `@nestjs/schedule` wrapper that
 * calls it periodically — see that file's own doc comment for why it's
 * deliberately NOT integration-tested.
 *
 * Race safety: `sweep()` runs `findStale()` then, per row,
 * `updateStatus(..., 'failed', ...)` with no row-level locking beyond what
 * each individual `UPDATE` statement already does. This is deliberately
 * simple, not an oversight: `AnalysisJobRepository.findStale()`'s query
 * excludes every terminal status (completed/completed_partial/failed) — the
 * instant a row's status flips to 'failed' (by this sweep, OR by a
 * legitimately-finishing `AnalysisProcessor` racing it), it drops out of
 * every SUBSEQUENT sweep's query (proven end-to-end by this file's own
 * "does not reappear on a second sweep" test — no separate locking
 * mechanism needed for THAT guarantee). The only residual race is a job
 * that finishes legitimately in the narrow window between this sweep's
 * `findStale()` read and its own terminal `updateStatus()` write for that
 * SAME row: the watchdog can then overwrite a legitimate terminal status
 * with 'failed' (a rare data-loss edge case at the
 * status/errorCode/errorMessage level — 5-minute sweep interval vs. a
 * multi-second final-write window). The quota side stays correct
 * regardless: `quota.refund()` is idempotent, so an extra refund racing a
 * legitimate completion either double-refunds safely (no-op) or, in the
 * rarer case the job was already refunded via
 * `AnalysisBelowThresholdError`, is also a safe no-op. No heroic locking
 * (e.g. a conditional `UPDATE ... WHERE status = $expected`) was added for
 * this MVP — the window is one sweep tick wide, and the failure mode is a
 * cosmetic status/error-message overwrite, never a quota-correctness bug.
 */
@Injectable()
export class StaleJobWatchdogService {
  private readonly logger = new Logger(StaleJobWatchdogService.name);

  constructor(
    @Inject(AnalysisJobRepository) private readonly jobs: AnalysisJobRepository,
    @Inject(USAGE_QUOTA_PORT) private readonly quota: UsageQuotaPort,
  ) {}

  async sweep(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_JOB_TIMEOUT_MS);
    const stale = await this.jobs.findStale(cutoff);

    for (const job of stale) {
      await this.jobs.updateStatus(job.id, "failed", {
        errorCode: STALE_JOB_WATCHDOG_ERROR_CODE,
        errorMessage: `Job exceeded the ${STALE_JOB_TIMEOUT_MS}ms stale-job timeout without reaching a terminal status.`,
      });
      await this.quota.refund(job.reservationId);
      this.logger.warn(`Marked stale job ${job.id} as failed and refunded reservation ${job.reservationId}`);
    }

    return stale.length;
  }
}
