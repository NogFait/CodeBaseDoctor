import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { AnalysisJobRepository, STALE_JOB_SWEEP_BATCH_SIZE, type CreateAnalysisJobInput } from "./analysis-job-repository";
import { startTestDatabase, type TestDatabase } from "../testing/postgres-test-db";

// Real Testcontainers Postgres — same pattern as prisma-score-repository /
// daily-free-tier-adapter integration specs. AnalysisJobRepository is
// deliberately NOT one of the 5 hexagonal ports (job/queue-lifecycle
// bookkeeping, not a swappable adapter behind a port), so there is no
// shared contract suite to run here — these tests exercise the concrete
// Prisma-backed implementation directly against the real schema
// (analysis_job + analysis_job_category, per prisma/schema.prisma).

const ALL_CATEGORIES = ["architecture", "documentation", "maintainability", "performance", "security", "testing"];

function input(overrides: Partial<CreateAnalysisJobInput> = {}): CreateAnalysisJobInput {
  return {
    repoUrl: "https://github.com/acme/widget",
    engineVersion: "abc12345",
    actorId: "user-1",
    reservationId: randomUUID(),
    ...overrides,
  };
}

describe("AnalysisJobRepository (Testcontainers Postgres)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  });

  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.prisma.$executeRaw`TRUNCATE TABLE analysis_job CASCADE`;
  });

  it("create() inserts the job row defaulted to status='queued' plus exactly 6 pending category rows", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const { id } = await repo.create(input());

    const record = await repo.findById(id);
    expect(record?.status).toBe("queued");
    expect(record?.categories).toHaveLength(6);
    expect(record?.categories.every((c) => c.status === "pending")).toBe(true);
    expect(record?.categories.map((c) => c.category).sort()).toEqual(ALL_CATEGORIES);
  });

  it("create() persists the supplied fields verbatim", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const reservationId = randomUUID();
    const { id } = await repo.create(
      input({ repoUrl: "https://github.com/acme/other", commitSha: "a".repeat(40), engineVersion: "deadbeef", actorId: "user-42", reservationId }),
    );

    const record = await repo.findById(id);
    expect(record?.repoUrl).toBe("https://github.com/acme/other");
    expect(record?.commitSha).toBe("a".repeat(40));
    expect(record?.engineVersion).toBe("deadbeef");
    expect(record?.actorId).toBe("user-42");
    expect(record?.reservationId).toBe(reservationId);
  });

  it("findById() returns null for a well-formed but unknown UUID", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const record = await repo.findById("00000000-0000-0000-0000-000000000000");
    expect(record).toBeNull();
  });

  it("findById() returns null (not a Prisma error) for a malformed id", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const record = await repo.findById("does-not-exist");
    expect(record).toBeNull();
  });

  it("updateStatus() transitions status and sets startedAt on the first move away from 'queued'", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const { id } = await repo.create(input());

    const before = await repo.findById(id);
    expect(before?.startedAt).toBeNull();
    expect(before?.finishedAt).toBeNull();

    await repo.updateStatus(id, "resolving");

    const after = await repo.findById(id);
    expect(after?.status).toBe("resolving");
    expect(after?.startedAt).toBeInstanceOf(Date);
    expect(after?.finishedAt).toBeNull();
  });

  // Characterization test for the SELECT+UPDATE -> single-transaction
  // refactor: the collapse must keep updateStatus()'s original
  // findUniqueOrThrow() contract that an unknown id is a hard error, not a
  // silent no-op (AnalysisProcessor relies on "on ANY thrown error" from
  // this write). RED if the leading write is a bare updateMany().
  it("updateStatus() throws (does not silently no-op) for a well-formed but unknown job id", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    await expect(repo.updateStatus("00000000-0000-0000-0000-000000000000", "analyzing")).rejects.toThrow();
  });

  it("updateStatus() does not move startedAt on a later, still-non-terminal transition", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const { id } = await repo.create(input());

    await repo.updateStatus(id, "resolving");
    const first = await repo.findById(id);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await repo.updateStatus(id, "cloning");
    const second = await repo.findById(id);

    expect(second?.status).toBe("cloning");
    expect(second?.startedAt?.getTime()).toBe(first?.startedAt?.getTime());
  });

  it("updateStatus() sets finishedAt on a terminal status and carries errorCode/errorMessage", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const { id } = await repo.create(input());

    await repo.updateStatus(id, "analyzing");
    await repo.updateStatus(id, "failed", { errorCode: "BELOW_THRESHOLD", errorMessage: "only 3/6 categories scored" });

    const record = await repo.findById(id);
    expect(record?.status).toBe("failed");
    expect(record?.finishedAt).toBeInstanceOf(Date);
    expect(record?.errorCode).toBe("BELOW_THRESHOLD");
    expect(record?.errorMessage).toBe("only 3/6 categories scored");
  });

  it("updateStatus() sets finishedAt on the 'completed_partial' terminal status too (triangulation)", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const { id } = await repo.create(input());

    await repo.updateStatus(id, "aggregating");
    await repo.updateStatus(id, "completed_partial", { repoScanId: undefined });

    const record = await repo.findById(id);
    expect(record?.status).toBe("completed_partial");
    expect(record?.finishedAt).toBeInstanceOf(Date);
  });

  it("updateStatus() can attach a repoScanId once a scan is persisted", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const { id } = await repo.create(input());
    const scanId = await createBareRepoScan(db);

    await repo.updateStatus(id, "completed", { repoScanId: scanId });

    const record = await repo.findById(id);
    expect(record?.repoScanId).toBe(scanId);
    expect(record?.status).toBe("completed");
  });

  it("attachBullJobId() sets bull_job_id without changing status", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const { id } = await repo.create(input());

    await repo.attachBullJobId(id, "bullmq-job-1");

    const record = await repo.findById(id);
    expect(record?.bullJobId).toBe("bullmq-job-1");
    expect(record?.status).toBe("queued");
  });

  it("updateCategoryStatus() updates only the targeted (jobId, category) row, never touching the other 5", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const { id } = await repo.create(input());

    await repo.updateCategoryStatus(id, "security", {
      status: "scored",
      score: 87,
      confidence: "measured",
      rationale: "clean scan",
      findings: [{ ruleId: "x", severity: "low", message: "m" }],
      durationMs: 1234,
    });

    const record = await repo.findById(id);
    const security = record?.categories.find((c) => c.category === "security");
    expect(security?.status).toBe("scored");
    expect(security?.score).toBe(87);
    expect(security?.confidence).toBe("measured");
    expect(security?.rationale).toBe("clean scan");
    expect(security?.findings).toEqual([{ ruleId: "x", severity: "low", message: "m" }]);
    expect(security?.durationMs).toBe(1234);

    const others = record?.categories.filter((c) => c.category !== "security") ?? [];
    expect(others).toHaveLength(5);
    expect(others.every((c) => c.status === "pending")).toBe(true);
    expect(others.every((c) => c.score === null)).toBe(true);
  });

  it("updateCategoryStatus() can mark a category 'running' then 'failed' with an errorCode, without score/rationale", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const { id } = await repo.create(input());

    await repo.updateCategoryStatus(id, "architecture", { status: "running" });
    const mid = await repo.findById(id);
    expect(mid?.categories.find((c) => c.category === "architecture")?.status).toBe("running");

    await repo.updateCategoryStatus(id, "architecture", { status: "failed", errorCode: "LLM_TIMEOUT" });
    const after = await repo.findById(id);
    const architecture = after?.categories.find((c) => c.category === "architecture");
    expect(architecture?.status).toBe("failed");
    expect(architecture?.errorCode).toBe("LLM_TIMEOUT");
  });

  it("updateCategoryStatus() concurrent updates to 2 DIFFERENT categories both land correctly (no lost updates)", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const { id } = await repo.create(input());

    await Promise.all([
      repo.updateCategoryStatus(id, "security", { status: "scored", score: 90 }),
      repo.updateCategoryStatus(id, "testing", { status: "scored", score: 40 }),
    ]);

    const record = await repo.findById(id);
    expect(record?.categories.find((c) => c.category === "security")?.score).toBe(90);
    expect(record?.categories.find((c) => c.category === "testing")?.score).toBe(40);
    expect(record?.categories.find((c) => c.category === "security")?.status).toBe("scored");
    expect(record?.categories.find((c) => c.category === "testing")?.status).toBe("scored");
  });

  it("findStale() returns a job whose startedAt is older than the cutoff and still non-terminal", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const { id } = await repo.create(input());
    await repo.updateStatus(id, "analyzing");

    // Backdate startedAt directly — no real 15-minute wait needed.
    const oldStartedAt = new Date(Date.now() - 20 * 60 * 1000);
    await db.prisma.analysisJob.update({ where: { id }, data: { startedAt: oldStartedAt } });

    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const stale = await repo.findStale(cutoff);

    expect(stale.map((s) => s.id)).toContain(id);
  });

  it("findStale() does not return a fresh (recently-started) job", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const { id } = await repo.create(input());
    await repo.updateStatus(id, "analyzing"); // startedAt = now

    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const stale = await repo.findStale(cutoff);

    expect(stale.map((s) => s.id)).not.toContain(id);
  });

  it("findStale() does not return a terminal-status job even if started long ago (already finished, not stuck)", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const { id } = await repo.create(input());
    await repo.updateStatus(id, "analyzing");
    await repo.updateStatus(id, "completed_partial");

    const oldStartedAt = new Date(Date.now() - 20 * 60 * 1000);
    await db.prisma.analysisJob.update({ where: { id }, data: { startedAt: oldStartedAt } });

    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const stale = await repo.findStale(cutoff);

    expect(stale.map((s) => s.id)).not.toContain(id);
  });

  it("findStale() caps its result at STALE_JOB_SWEEP_BATCH_SIZE and returns the oldest-started jobs first", async () => {
    // verify WARNING 3: sweep() fans out ~2 concurrent pooled DB ops per
    // returned row, so findStale() must bound its result — otherwise a mass
    // worker-crash backlog saturates the Prisma pool. Also asserts the
    // deterministic oldest-first order the partial index supports, so a
    // large backlog drains predictably across scheduler ticks.
    const repo = new AnalysisJobRepository(db.prisma);
    const total = STALE_JOB_SWEEP_BATCH_SIZE + 5;
    const base = Date.now() - 20 * 60 * 1000;

    const idsOldestFirst: string[] = [];
    for (let i = 0; i < total; i++) {
      const { id } = await repo.create(input());
      await repo.updateStatus(id, "analyzing");
      // i = 0 gets the largest backdate -> it is the oldest; strictly
      // increasing startedAt as i grows.
      await db.prisma.analysisJob.update({
        where: { id },
        data: { startedAt: new Date(base - (total - i) * 1000) },
      });
      idsOldestFirst.push(id);
    }

    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const stale = await repo.findStale(cutoff);

    expect(stale).toHaveLength(STALE_JOB_SWEEP_BATCH_SIZE);
    expect(stale.map((s) => s.id)).toEqual(idsOldestFirst.slice(0, STALE_JOB_SWEEP_BATCH_SIZE));
  });

  it("updateStatusIfCurrentlyIn() transitions and returns true when the current status is one of the allowed statuses (CAS success)", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const { id } = await repo.create(input());
    await repo.updateStatus(id, "analyzing");

    const transitioned = await repo.updateStatusIfCurrentlyIn(id, ["analyzing", "cloning"], "failed", {
      errorCode: "JOB_WATCHDOG_TIMEOUT",
      errorMessage: "stale",
    });

    expect(transitioned).toBe(true);
    const record = await repo.findById(id);
    expect(record?.status).toBe("failed");
    expect(record?.errorCode).toBe("JOB_WATCHDOG_TIMEOUT");
    expect(record?.finishedAt).toBeInstanceOf(Date);
  });

  it("updateStatusIfCurrentlyIn() does NOT transition and returns false when the current status is not one of the allowed statuses (CAS failure — the race the watchdog must not lose)", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const { id } = await repo.create(input());
    await repo.updateStatus(id, "analyzing");
    // Simulate the job having legitimately reached a terminal status already
    // (e.g. AnalysisProcessor finished it) BEFORE the CAS write is attempted.
    await repo.updateStatus(id, "completed_partial");

    const transitioned = await repo.updateStatusIfCurrentlyIn(id, ["analyzing", "cloning"], "failed", {
      errorCode: "JOB_WATCHDOG_TIMEOUT",
      errorMessage: "stale",
    });

    expect(transitioned).toBe(false);
    const record = await repo.findById(id);
    expect(record?.status).toBe("completed_partial");
    expect(record?.errorCode).toBeNull();
  });

  it("rejects a second job created with an already-used reservationId (unique constraint)", async () => {
    const repo = new AnalysisJobRepository(db.prisma);
    const reservationId = randomUUID();
    await repo.create(input({ reservationId }));

    let caught: unknown;
    try {
      await repo.create(input({ reservationId, repoUrl: "https://github.com/acme/second" }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");

    // The failed create() must not have left a partial job (no orphaned
    // category rows from the failed second insert either — the create() is
    // one transaction).
    const jobs = await db.prisma.analysisJob.findMany({ where: { reservationId } });
    expect(jobs).toHaveLength(1);
  });
});

async function createBareRepoScan(db: TestDatabase): Promise<string> {
  const scan = await db.prisma.repoScan.create({
    data: {
      repoUrl: "https://github.com/acme/widget",
      commitSha: "b".repeat(40),
      engineVersion: "abc12345",
      status: "complete",
      compositeScore: 90,
      completeness: 1,
      dominantLanguage: "TypeScript",
      languageMix: [],
      categories: [],
    },
  });
  return scan.id;
}
