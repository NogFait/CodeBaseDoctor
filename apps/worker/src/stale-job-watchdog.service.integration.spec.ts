import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AnalysisJobRepository } from "@cbd/persistence";
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
});
