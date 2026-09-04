import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { AnalysisJobRepository, type CreateAnalysisJobInput } from "./analysis-job-repository";
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
