import { Inject, Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { StaleJobWatchdogService } from "./stale-job-watchdog.service";

/**
 * 5 minutes — comfortably under `STALE_JOB_TIMEOUT_MS` (15 minutes), so a
 * job that just crossed the staleness threshold is picked up on one of the
 * next couple of ticks rather than sitting stuck for a near-full extra
 * cycle.
 */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Thin scheduling wrapper around `StaleJobWatchdogService.sweep()`. All
 * actual policy lives in the service (see its own doc comment), which is
 * what `stale-job-watchdog.service.integration.spec.ts` tests directly
 * against real Postgres. This class is deliberately NOT covered by an
 * integration test — per the design's testing strategy for this task, a
 * real-time test of `@Interval`/`@Cron` wiring itself (waiting out a real
 * 5-minute interval, or mocking timers to fake one) would only prove
 * `@nestjs/schedule` calls methods on a schedule, not anything specific to
 * this codebase. Its only job is "call sweep() every SWEEP_INTERVAL_MS" —
 * trivial wiring, no branching logic of its own to get wrong.
 */
@Injectable()
export class StaleJobWatchdogScheduler {
  private readonly logger = new Logger(StaleJobWatchdogScheduler.name);

  // Explicit @Inject() for the concrete-class param — see
  // StaleJobWatchdogService's / AnalysisProcessor's own constructors for
  // why ambient reflection is not relied on for concrete classes in this
  // codebase.
  constructor(@Inject(StaleJobWatchdogService) private readonly watchdog: StaleJobWatchdogService) {}

  @Interval(SWEEP_INTERVAL_MS)
  async onInterval(): Promise<void> {
    const count = await this.watchdog.sweep();
    if (count > 0) {
      this.logger.log(`Stale-job sweep marked ${count} job(s) as failed`);
    }
  }
}
