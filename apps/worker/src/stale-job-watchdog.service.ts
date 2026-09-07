import { Inject, Injectable, Logger } from "@nestjs/common";
import { USAGE_QUOTA_PORT, type UsageQuotaPort } from "@cbd/analysis";
import { AnalysisJobRepository, NON_TERMINAL_STATUSES, type StaleAnalysisJob } from "@cbd/persistence";

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
 * Race safety: `sweep()` runs `findStale()` then, per row, a
 * COMPARE-AND-SWAP write via `AnalysisJobRepository.updateStatusIfCurrentlyIn()`
 * — `UPDATE ... WHERE id = $1 AND status IN (<non-terminal>)`. This closes
 * the race that an earlier, unconditional-`updateStatus()` version of this
 * method had: a job that finishes legitimately (to 'completed' or
 * 'completed_partial') in the narrow window between this sweep's
 * `findStale()` read and its own per-job write for that SAME row is no
 * longer clobbered back to 'failed' — the CAS write's `WHERE status IN
 * (...)` no longer matches (the row already moved to a terminal status), so
 * `updateStatusIfCurrentlyIn()` returns `false`, and the watchdog does
 * NOTHING to that row: no status overwrite, no refund. This is a genuine
 * correctness fix, not cosmetic: without it, a job that actually succeeded
 * and consumed real compute would be incorrectly refunded (see this file's
 * "does NOT overwrite or refund a job that legitimately reaches a terminal
 * status in the race window" test, which reproduces the race directly by
 * racing a real completion write in right after `findStale()`'s snapshot).
 * The already-covered "does not reappear on a second sweep" guarantee still
 * holds unchanged: `findStale()` excludes every terminal status, so a row
 * this sweep DID legitimately fail (CAS succeeded) drops out of every
 * subsequent sweep's query same as before.
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
    // By design one sweep() processes at most one bounded batch:
    // findStale() is capped at STALE_JOB_SWEEP_BATCH_SIZE (oldest-first), so
    // the per-row fan-out below can't stampede the Prisma pool. The
    // scheduler re-runs sweep() every tick, so a larger backlog drains
    // across ticks instead of in one unbounded pass.
    const stale = await this.jobs.findStale(cutoff);

    // Each stale row is independent — a distinct `analysis_job` row and a
    // distinct `reservationId` — with no ordering dependency and no shared
    // mutable accumulator (the count is derived from the results below), so
    // the batch is processed concurrently instead of one `await` at a time.
    // Per ROW, the CAS write still strictly precedes and gates that row's
    // refund (see `failStaleJob`); only different rows now overlap. Error
    // behaviour is unchanged in kind: if any row's write or refund rejects,
    // `Promise.all` rejects and so does `sweep()` — the scheduler re-runs
    // it on the next tick.
    const outcomes = await Promise.all(stale.map((job) => this.failStaleJob(job)));
    return outcomes.filter(Boolean).length;
  }

  /**
   * Fails one stale candidate. Returns `true` iff this sweep actually owned
   * the transition to 'failed' (its CAS write won the race) and therefore
   * issued the refund; `false` if the row had already reached a terminal
   * status by the time the CAS ran (nothing is written or refunded).
   */
  private async failStaleJob(job: StaleAnalysisJob): Promise<boolean> {
    const transitioned = await this.jobs.updateStatusIfCurrentlyIn(job.id, NON_TERMINAL_STATUSES, "failed", {
      errorCode: STALE_JOB_WATCHDOG_ERROR_CODE,
      errorMessage: `Job exceeded the ${STALE_JOB_TIMEOUT_MS}ms stale-job timeout without reaching a terminal status.`,
    });
    if (!transitioned) {
      // Lost the race: the job legitimately reached a terminal status
      // between findStale()'s snapshot and this write. Do NOT touch it,
      // do NOT refund it.
      this.logger.log(`Skipped stale-job candidate ${job.id}: it reached a terminal status before the watchdog's write.`);
      return false;
    }
    // CAS write intentionally stays FIRST here (unlike AnalysisProcessor's
    // catch block, which was reordered to refund-then-status-write): the
    // CAS's own boolean result is what GATES whether this refund call
    // happens at all — the decision "did this sweep actually own the
    // transition to 'failed'" isn't known until this write returns.
    // There's a narrow, accepted window between this write committing and
    // the refund below landing where a poller could see status:'failed'
    // slightly before the refund is reflected — structurally unavoidable
    // given that causal dependency, and distinct from the (fixed)
    // refund-can-be-skipped bug this CAS itself closes.
    await this.quota.refund(job.reservationId);
    this.logger.warn(`Marked stale job ${job.id} as failed and refunded reservation ${job.reservationId}`);
    return true;
  }
}
