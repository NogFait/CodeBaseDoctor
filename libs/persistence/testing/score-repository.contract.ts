import { beforeEach, describe, expect, it } from "vitest";
import type { CategoryScore, RepoScoreReport, ScoreRepositoryPort } from "@cbd/analysis";

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

/**
 * Shared contract suite for ScoreRepositoryPort. Run it against any
 * implementation via `describeScoreRepositoryContract(() => new Impl())` —
 * used here against InMemoryScoreRepository, and later (Phase 3) against
 * PrismaScoreRepository via Testcontainers, without duplicating assertions.
 * See spec: scan-persistence; design decision #6.
 */
export function describeScoreRepositoryContract(makeRepo: () => ScoreRepositoryPort): void {
  describe("ScoreRepositoryPort contract", () => {
    let repo: ScoreRepositoryPort;

    beforeEach(() => {
      repo = makeRepo();
    });

    describe("save + findById", () => {
      it("persists a report and assigns an id", async () => {
        const saved = await repo.save(makeReport());

        expect(saved.id).toBeTruthy();
        const found = await repo.findById(saved.id);
        expect(found?.id).toBe(saved.id);
        expect(found?.repoUrl).toBe(saved.repoUrl);
      });

      it("returns null for an unknown id", async () => {
        await repo.save(makeReport());

        const found = await repo.findById("does-not-exist");

        expect(found).toBeNull();
      });

      it("does not mutate a previously saved scan when a later scan is saved (immutability)", async () => {
        const saved = await repo.save(makeReport({ compositeScore: 50 }));
        await repo.save(makeReport({ compositeScore: 90, commitSha: "b".repeat(40) }));

        const reFetched = await repo.findById(saved.id);

        expect(reFetched?.compositeScore).toBe(50);
      });
    });

    describe("findCached", () => {
      it("returns null when no scan exists for the key", async () => {
        const found = await repo.findCached({
          repoUrl: "https://github.com/acme/widget",
          commitSha: "a".repeat(40),
          engineVersion: "1.0.0",
        });

        expect(found).toBeNull();
      });

      it("returns the matching complete scan (cache hit)", async () => {
        const saved = await repo.save(makeReport({ status: "complete" }));

        const found = await repo.findCached({
          repoUrl: saved.repoUrl,
          commitSha: saved.commitSha,
          engineVersion: saved.engineVersion,
        });

        expect(found?.id).toBe(saved.id);
      });

      it("does NOT return a partial scan as a cache hit", async () => {
        await repo.save(makeReport({ status: "partial", completeness: 0.83 }));

        const found = await repo.findCached({
          repoUrl: "https://github.com/acme/widget",
          commitSha: "a".repeat(40),
          engineVersion: "1.0.0",
        });

        expect(found).toBeNull();
      });

      it("is a cache miss when engineVersion differs (version bump invalidates)", async () => {
        await repo.save(makeReport({ status: "complete", engineVersion: "1.0.0" }));

        const found = await repo.findCached({
          repoUrl: "https://github.com/acme/widget",
          commitSha: "a".repeat(40),
          engineVersion: "2.0.0",
        });

        expect(found).toBeNull();
      });

      it("prefers a complete scan even when a partial exists for the same key", async () => {
        await repo.save(makeReport({ status: "partial", completeness: 0.83 }));
        const complete = await repo.save(makeReport({ status: "complete" }));

        const found = await repo.findCached({
          repoUrl: complete.repoUrl,
          commitSha: complete.commitSha,
          engineVersion: complete.engineVersion,
        });

        expect(found?.id).toBe(complete.id);
        expect(found?.status).toBe("complete");
      });
    });

    describe("listByRepo", () => {
      it("returns scans for the repo sorted newest-first", async () => {
        const repoUrl = "https://github.com/acme/widget";
        const older = await repo.save(
          makeReport({ repoUrl, commitSha: "a".repeat(40), createdAt: new Date("2026-01-01T00:00:00Z") }),
        );
        const newer = await repo.save(
          makeReport({ repoUrl, commitSha: "b".repeat(40), createdAt: new Date("2026-02-01T00:00:00Z") }),
        );

        const list = await repo.listByRepo(repoUrl, 10);

        expect(list.map((s) => s.id)).toEqual([newer.id, older.id]);
      });

      it("respects the limit", async () => {
        const repoUrl = "https://github.com/acme/widget";
        await repo.save(makeReport({ repoUrl, commitSha: "a".repeat(40) }));
        await repo.save(makeReport({ repoUrl, commitSha: "b".repeat(40) }));
        await repo.save(makeReport({ repoUrl, commitSha: "c".repeat(40) }));

        const list = await repo.listByRepo(repoUrl, 2);

        expect(list).toHaveLength(2);
      });

      it("excludes scans from other repos", async () => {
        await repo.save(makeReport({ repoUrl: "https://github.com/acme/widget" }));
        await repo.save(makeReport({ repoUrl: "https://github.com/acme/other" }));

        const list = await repo.listByRepo("https://github.com/acme/widget", 10);

        expect(list).toHaveLength(1);
        expect(list[0].repoUrl).toBe("https://github.com/acme/widget");
      });
    });
  });
}
