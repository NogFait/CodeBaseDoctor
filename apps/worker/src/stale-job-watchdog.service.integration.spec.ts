import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AnalysisJobRepository, STALE_JOB_SWEEP_BATCH_SIZE } from "@cbd/persistence";
import { startTestDatabase, type TestDatabase } from "@cbd/persistence/testing/postgres-test-db";
import { InMemoryQuota } from "@cbd/persistence/testing/in-memory-quota";
import { STALE_JOB_TIMEOUT_MS, STALE_JOB_WATCHDOG_ERROR_CODE, StaleJobWatchdogService } from "./stale-job-watchdog.service";

// Real Testcontainers Postgres (same pattern as
// analysis-job-repository.integration.spec.ts, which already covers
// findStale() at the query level) + a real AnalysisJobRepository. `sweep()`
// is tested directly (no Nest DI, no @Cron/@Interval wiring) against a
// GENUINELY backdated row — not mocked, not a fake 15-minute wait: a raw
// Prisma update pushes `startedAt` into the past, exactly like
// analysis-job-repository.integration.spec.ts's own findStale() tests do.
// UsageQuotaPort is InMemoryQuota — this suite is testing the watchdog's
// OWN sweep/refund orchestration, not persistence-adapter correctness.

const ACTOR_ID = "actor-1";

function input(overrides: Partial<{ repoUrl: string; engineVersion: string; actorId: string; reservationId: string }> = {}) {
  return {
    repoUrl: "https://github.com/acme/widget",
    engineVersion: "test-engine",
    actorId: ACTOR_ID,
    reservationId: randomUUID(),
    ...overrides,
  };
}

describe("StaleJobWatchdogService.sweep() (Testcontainers Postgres)", () => {
  let db: TestDatabase;
  let jobsRepo: AnalysisJobRepository;

  beforeAll(async () => {
    db = await startTestDatabase();
    jobsRepo = new AnalysisJobRepository(db.prisma);
  });

  afterAll(async () => {
    await db.stop();
  });

  afterEach(async () => {
    await db.prisma.$executeRaw`TRUNCATE TABLE analysis_job CASCADE`;
  });

  async function backdateStartedAt(jobId: string, ageMs: number): Promise<void> {
    await db.prisma.analysisJob.update({
      where: { id: jobId },
      data: { startedAt: new Date(Date.now() - ageMs) },
    });
  }

  it("marks a genuinely stale, non-terminal job 'failed' and refunds its quota reservation", async () => {
    const quota = new InMemoryQuota({ limit: 5 });
    const reservationId = randomUUID();
    const { id } = await jobsRepo.create(input({ reservationId }));
    await jobsRepo.updateStatus(id, "analyzing"); // sets startedAt
    await backdateStartedAt(id, STALE_JOB_TIMEOUT_MS + 60_000);
    // Consume the reservation for real so refund() has something to undo —
    // mirrors what AnalysisProcessor would have done before crashing.
    await quota.consume(ACTOR_ID, reservationId);

    const watchdog = new StaleJobWatchdogService(jobsRepo, quota);
    const count = await watchdog.sweep();

    expect(count).toBe(1);
    const record = await jobsRepo.findById(id);
    expect(record?.status).toBe("failed");
    expect(record?.errorCode).toBe(STALE_JOB_WATCHDOG_ERROR_CODE);
    expect(quota.refundCalls).toContain(reservationId);
    const decision = await quota.peek(ACTOR_ID);
    expect(decision.remaining).toBe(5);
  });

  it("does not touch a fresh (recently-started) job", async () => {
    const quota = new InMemoryQuota({ limit: 5 });
    const reservationId = randomUUID();
    const { id } = await jobsRepo.create(input({ reservationId }));
    await jobsRepo.updateStatus(id, "analyzing"); // startedAt = now

    const watchdog = new StaleJobWatchdogService(jobsRepo, quota);
    const count = await watchdog.sweep();

    expect(count).toBe(0);
    const record = await jobsRepo.findById(id);
    expect(record?.status).toBe("analyzing");
    expect(quota.refundCalls).toHaveLength(0);
  });

  it("does not touch a job already in a terminal status, even if started long ago", async () => {
    const quota = new InMemoryQuota({ limit: 5 });
    const reservationId = randomUUID();
    const { id } = await jobsRepo.create(input({ reservationId }));
    await jobsRepo.updateStatus(id, "analyzing");
    await jobsRepo.updateStatus(id, "completed_partial");
    await backdateStartedAt(id, STALE_JOB_TIMEOUT_MS + 60_000);

    const watchdog = new StaleJobWatchdogService(jobsRepo, quota);
    const count = await watchdog.sweep();

    expect(count).toBe(0);
    const record = await jobsRepo.findById(id);
    expect(record?.status).toBe("completed_partial");
    expect(quota.refundCalls).toHaveLength(0);
  });

  it("sweeps multiple stale jobs in one pass and leaves a mixed-freshness job untouched", async () => {
    const quota = new InMemoryQuota({ limit: 5 });
    const staleA = await jobsRepo.create(input({ reservationId: randomUUID() }));
    const staleB = await jobsRepo.create(input({ reservationId: randomUUID() }));
    const fresh = await jobsRepo.create(input({ reservationId: randomUUID() }));

    await jobsRepo.updateStatus(staleA.id, "analyzing");
    await jobsRepo.updateStatus(staleB.id, "cloning");
    await jobsRepo.updateStatus(fresh.id, "analyzing");
    await backdateStartedAt(staleA.id, STALE_JOB_TIMEOUT_MS + 60_000);
    await backdateStartedAt(staleB.id, STALE_JOB_TIMEOUT_MS + 120_000);

    const watchdog = new StaleJobWatchdogService(jobsRepo, quota);
    const count = await watchdog.sweep();

    expect(count).toBe(2);
    expect((await jobsRepo.findById(staleA.id))?.status).toBe("failed");
    expect((await jobsRepo.findById(staleB.id))?.status).toBe("failed");
    expect((await jobsRepo.findById(fresh.id))?.status).toBe("analyzing");
  });

  it("a job already 'failed' by the FIRST sweep does not reappear on a SECOND sweep (no double-processing across ticks)", async () => {
    const quota = new InMemoryQuota({ limit: 5 });
    const reservationId = randomUUID();
    const { id } = await jobsRepo.create(input({ reservationId }));
    await jobsRepo.updateStatus(id, "analyzing");
    await backdateStartedAt(id, STALE_JOB_TIMEOUT_MS + 60_000);
    await quota.consume(ACTOR_ID, reservationId);

    const watchdog = new StaleJobWatchdogService(jobsRepo, quota);
    const first = await watchdog.sweep();
    expect(first).toBe(1);

    const second = await watchdog.sweep();
    expect(second).toBe(0);

    // The second sweep's refund() call (had there been one) would still be
    // a safe no-op either way — but there SHOULDN'T be a second call at
    // all, since findStale() excludes the now-'failed' row entirely.
    expect(quota.refundCalls).toHaveLength(1);
  });

  it("drains a backlog larger than one batch across successive sweeps (each tick processes at most STALE_JOB_SWEEP_BATCH_SIZE, oldest-first)", async () => {
    // verify WARNING 3: a mass worker-crash can leave far more than one
    // batch of stale rows. One sweep() must fail exactly one bounded batch
    // (so the concurrent per-row fan-out can't stampede the Prisma pool);
    // the backlog drains on subsequent ticks. RED against the unbounded
    // findStale() (one sweep would fail the whole herd in a single
    // Promise.all).
    const total = STALE_JOB_SWEEP_BATCH_SIZE + 10;
    const quota = new InMemoryQuota({ limit: total * 2 });

    for (let i = 0; i < total; i++) {
      const reservationId = randomUUID();
      const { id } = await jobsRepo.create(input({ reservationId }));
      await jobsRepo.updateStatus(id, "analyzing");
      // strictly increasing age as i grows: i = 0 is the oldest.
      await backdateStartedAt(id, STALE_JOB_TIMEOUT_MS + 60_000 + (total - i) * 1000);
      await quota.consume(ACTOR_ID, reservationId);
    }

    const watchdog = new StaleJobWatchdogService(jobsRepo, quota);

    const first = await watchdog.sweep();
    expect(first).toBe(STALE_JOB_SWEEP_BATCH_SIZE);

    const second = await watchdog.sweep();
    expect(second).toBe(total - STALE_JOB_SWEEP_BATCH_SIZE);

    const third = await watchdog.sweep();
    expect(third).toBe(0);

    // Every stale row ended 'failed' and every reservation was refunded
    // exactly once across the drain.
    expect(quota.refundCalls).toHaveLength(total);
  });

  it("does NOT overwrite or refund a job that legitimately reaches a terminal status in the race window between findStale()'s snapshot and sweep()'s per-job write (bug fix: was an unconditional update with no CAS)", async () => {
    const quota = new InMemoryQuota({ limit: 5 });
    const reservationId = randomUUID();
    const { id } = await jobsRepo.create(input({ reservationId }));
    await jobsRepo.updateStatus(id, "analyzing");
    await backdateStartedAt(id, STALE_JOB_TIMEOUT_MS + 60_000);
    await quota.consume(ACTOR_ID, reservationId);

    const watchdog = new StaleJobWatchdogService(jobsRepo, quota);

    // Simulate AnalysisProcessor legitimately finishing THIS SAME job in the
    // narrow window between findStale()'s snapshot (which still sees it
    // non-terminal) and sweep()'s subsequent per-job write for that row —
    // by racing a real 'completed_partial' write in right after the
    // snapshot resolves, before sweep() gets a chance to act on it.
    const originalFindStale = jobsRepo.findStale.bind(jobsRepo);
    const findStaleSpy = vi.spyOn(jobsRepo, "findStale").mockImplementationOnce(async (cutoff) => {
      const stale = await originalFindStale(cutoff);
      await jobsRepo.updateStatus(id, "completed_partial", { repoScanId: undefined });
      return stale;
    });

    const count = await watchdog.sweep();

    expect(count).toBe(0);
    const record = await jobsRepo.findById(id);
    expect(record?.status).toBe("completed_partial");
    expect(record?.errorCode).toBeNull();
    expect(quota.refundCalls).toHaveLength(0);
    // The job legitimately consumed its reservation and finished — the
    // quota must NOT read as refunded.
    const decision = await quota.peek(ACTOR_ID);
    expect(decision.remaining).toBe(4);

    findStaleSpy.mockRestore();
  });

  // Characterization test for the sequential-loop -> Promise.all refactor:
  // parallelising the per-row work must NOT swallow a failure. If any row's
  // CAS write or refund rejects, sweep() must still reject (the scheduler
  // re-runs it next tick) — the same contract the old `for` loop had (it
  // had no try/catch). RED if sweep() were changed to Promise.allSettled
  // with log-and-continue.
  it("sweep() rejects if a per-row refund throws (failure is not swallowed under concurrency)", async () => {
    class RefundThrowsQuota extends InMemoryQuota {
      override async refund(): Promise<void> {
        throw new Error("refund boom");
      }
    }

    const reservationId = randomUUID();
    const { id } = await jobsRepo.create(input({ reservationId }));
    await jobsRepo.updateStatus(id, "analyzing");
    await backdateStartedAt(id, STALE_JOB_TIMEOUT_MS + 60_000);

    const watchdog = new StaleJobWatchdogService(jobsRepo, new RefundThrowsQuota({ limit: 5 }));

    await expect(watchdog.sweep()).rejects.toThrow("refund boom");
  });
});
