import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import type { CategoryScore, RepoScoreReport } from "@cbd/analysis";
import { PrismaScoreRepository } from "./prisma-score-repository";
import { describeScoreRepositoryContract } from "../testing/score-repository.contract";
import { startTestDatabase, type TestDatabase } from "../testing/postgres-test-db";

// Real Testcontainers Postgres. No mocking of Prisma, no in-memory
// substitute — see design decision #4/#6 and libs/persistence/testing/
// score-repository.contract.ts's doc comment: this is the whole reason the
// shared contract suite exists, run UNMODIFIED (imported, not copied)
// against a real adapter and a real database.

function makeCategoryScore(overrides: Partial<CategoryScore> = {}): CategoryScore {
  return {
    category: "security",
    status: "scored",
    score: 80,
    confidence: "measured",
    weightCap: 1,
    rationale: "no critical findings",
    findings: [],
    durationMs: 10,
    ...overrides,
  };
}

function makeReport(overrides: Partial<RepoScoreReport> = {}): RepoScoreReport {
  return {
    repoUrl: "https://github.com/acme/widget",
    commitSha: "a".repeat(40),
    engineVersion: "1.0.0",
    status: "complete",
    compositeScore: 80,
    completeness: 1,
    dominantLanguage: "TypeScript",
    languageMix: [{ language: "TypeScript", loc: 100, share: 1 }],
    categories: [makeCategoryScore()],
    createdAt: new Date(),
    ...overrides,
  };
}

describe("PrismaScoreRepository (Testcontainers Postgres)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  });

  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    // The shared contract suite (and the tests below) reuse fixed
    // repoUrl/commitSha values across cases. Unlike InMemoryScoreRepository
    // (a fresh Map per test via makeRepo()), a real Postgres database
    // persists rows across tests in the same file unless explicitly reset.
    await db.prisma.$executeRaw`TRUNCATE TABLE repo_scan CASCADE`;
  });

  // --- Shared ScoreRepositoryPort contract suite (Phase 2, task 2.6) -------
  // Imported and run UNMODIFIED against the real adapter (this file never
  // edits testing/score-repository.contract.ts). One PrismaScoreRepository
  // behavior change WAS required to make it pass: `findById()` guards with
  // a UUID-shape check before querying. Postgres's `@db.Uuid` column type
  // rejects a non-UUID string ("does-not-exist", used by the suite's
  // "returns null for an unknown id" case) as a hard query error, not a
  // "no rows found" result — unlike InMemoryScoreRepository's
  // `Map.get(id) ?? null`, which never errors on an unrecognized key shape.
  // See the UUID_PATTERN guard in prisma-score-repository.ts. With that one
  // adapter-side fix, the suite otherwise passes unmodified.
  describeScoreRepositoryContract(() => new PrismaScoreRepository(db.prisma));

  // --- Postgres-specific: the real repo_scan_cache_uniq partial index ------
  // (beyond anything the in-memory double could ever exercise)
  describe("repo_scan_cache_uniq partial unique index", () => {
    const KEY = { repoUrl: "https://github.com/acme/partial-index-test", commitSha: "c".repeat(40), engineVersion: "1.0.0" };

    it("rejects a second status='complete' insert for the same (repoUrl, commitSha, engineVersion)", async () => {
      const repo = new PrismaScoreRepository(db.prisma);
      await repo.save(makeReport({ ...KEY, status: "complete" }));

      // Explicit, tested outcome: the adapter does NOT swallow or translate
      // this — it lets the real Postgres unique_violation propagate as
      // Prisma's typed P2002 error, so a caller that expects findCached()
      // to have been consulted first sees an unambiguous failure rather
      // than a silently-accepted duplicate.
      let caught: unknown;
      try {
        await repo.save(makeReport({ ...KEY, status: "complete" }));
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((caught as Prisma.PrismaClientKnownRequestError).code).toBe("P2002");
    });

    it("allows a status='partial' scan to coexist with an existing status='complete' scan for the same key", async () => {
      const repo = new PrismaScoreRepository(db.prisma);
      const complete = await repo.save(makeReport({ ...KEY, status: "complete" }));
      const partial = await repo.save(makeReport({ ...KEY, status: "partial", completeness: 0.67 }));

      expect(partial.id).not.toBe(complete.id);
      const both = await repo.listByRepo(KEY.repoUrl, 10);
      expect(both.map((s) => s.id).sort()).toEqual([complete.id, partial.id].sort());
    });

    it("saveForced() refreshes the existing status='complete' row IN PLACE instead of throwing P2002 (the forceRescan path)", async () => {
      const repo = new PrismaScoreRepository(db.prisma);
      const original = await repo.save(makeReport({ ...KEY, status: "complete", compositeScore: 50 }));

      // A forced re-scan of an unchanged repo: same (repoUrl, commitSha,
      // engineVersion), new result. save() would throw P2002 here (see the
      // test above); saveForced() updates the existing row in place.
      const rescanned = await repo.saveForced(makeReport({ ...KEY, status: "complete", compositeScore: 90 }));

      expect(rescanned.id).toBe(original.id); // same row, stable id
      expect(rescanned.compositeScore).toBe(90); // fresh data

      // Still exactly one complete row for the key, and findCached sees the
      // fresh data on the stable id.
      const found = await repo.findCached(KEY);
      expect(found?.id).toBe(original.id);
      expect(found?.compositeScore).toBe(90);
      const all = await repo.listByRepo(KEY.repoUrl, 10);
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe(original.id);
    });

    it("saveForced() keeps a referencing analysis_job.repo_scan_id intact (the ON DELETE SET NULL / 500 guard)", async () => {
      const repo = new PrismaScoreRepository(db.prisma);
      const original = await repo.save(makeReport({ ...KEY, status: "complete", compositeScore: 50 }));

      // A prior completed job points at that scan — exactly what
      // get-analysis-response.ts assumes always holds for a completed job.
      const job = await db.prisma.analysisJob.create({
        data: {
          repoUrl: KEY.repoUrl,
          commitSha: KEY.commitSha,
          engineVersion: KEY.engineVersion,
          actorId: "actor-1",
          reservationId: randomUUID(),
          status: "completed",
          repoScanId: original.id,
        },
      });

      await repo.saveForced(makeReport({ ...KEY, status: "complete", compositeScore: 90 }));

      const reloaded = await db.prisma.analysisJob.findUniqueOrThrow({ where: { id: job.id } });
      // If saveForced() had deleted+reinserted the scan, the FK
      // (ON DELETE SET NULL) would have nulled this — turning
      // GET /analyses/<job> into a 500.
      expect(reloaded.repoScanId).toBe(original.id);
    });

    it("allows a later status='complete' insert for the same key after an earlier status='partial' exists", async () => {
      const repo = new PrismaScoreRepository(db.prisma);
      // Simulates design decision #6's "failed-then-succeeded" sequence: a
      // partial scan gets cached first (e.g. one analyzer failed), then a
      // later re-scan of the SAME commit succeeds fully.
      const partial = await repo.save(makeReport({ ...KEY, status: "partial", completeness: 0.83 }));
      const complete = await repo.save(makeReport({ ...KEY, status: "complete" }));

      expect(complete.id).not.toBe(partial.id);

      // findCached returns the complete scan, not the partial, even though
      // the partial was inserted first and both rows exist.
      const found = await repo.findCached(KEY);
      expect(found?.id).toBe(complete.id);
      expect(found?.status).toBe("complete");
    });
  });
});
