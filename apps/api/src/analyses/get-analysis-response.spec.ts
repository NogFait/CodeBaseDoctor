import { describe, expect, it } from "vitest";
import type { AnalysisJobCategoryRow, AnalysisJobRecord } from "@cbd/persistence";
import type { CategoryScore, RepoScan } from "@cbd/analysis";
import { mapAnalysisJobToResponse } from "./get-analysis-response";

const ALL_CATEGORIES = [
  "security",
  "testing",
  "maintainability",
  "architecture",
  "documentation",
  "performance",
] as const;

function categoryRow(overrides: Partial<AnalysisJobCategoryRow> & { category: string }): AnalysisJobCategoryRow {
  return {
    status: "pending",
    score: null,
    confidence: null,
    rationale: null,
    findings: [],
    errorCode: null,
    durationMs: null,
    updatedAt: new Date("2026-08-14T00:00:00Z"),
    ...overrides,
  };
}

function baseJob(overrides: Partial<AnalysisJobRecord> = {}): AnalysisJobRecord {
  return {
    id: "job-1",
    repoUrl: "https://github.com/o/r",
    commitSha: "a".repeat(40),
    engineVersion: "abcd1234",
    actorId: "actor-1",
    reservationId: "reservation-1",
    status: "analyzing",
    errorCode: null,
    errorMessage: null,
    repoScanId: null,
    bullJobId: "bull-1",
    attempts: 0,
    createdAt: new Date("2026-08-14T00:00:00Z"),
    startedAt: new Date("2026-08-14T00:00:01Z"),
    finishedAt: null,
    categories: ALL_CATEGORIES.map((category) => categoryRow({ category })),
    ...overrides,
  };
}

function repoScan(overrides: Partial<RepoScan> = {}): RepoScan {
  const categories: CategoryScore[] = ALL_CATEGORIES.map((category) => ({
    category,
    status: "scored",
    score: 80,
    confidence: "measured",
    weightCap: category === "performance" ? 0.5 : 1,
    rationale: `${category} looks fine`,
    findings: [],
    durationMs: 5,
  }));
  return {
    id: "scan-1",
    repoUrl: "https://github.com/o/r",
    commitSha: "a".repeat(40),
    engineVersion: "abcd1234",
    status: "complete",
    compositeScore: 80,
    completeness: 1,
    dominantLanguage: "TypeScript",
    languageMix: [],
    categories,
    createdAt: new Date("2026-08-14T00:05:00Z"),
    ...overrides,
  };
}

describe("mapAnalysisJobToResponse", () => {
  it.each(["queued", "resolving", "cloning", "analyzing", "aggregating"] as const)(
    "in-progress status '%s' maps to response status 'analyzing' with per-category progress",
    (jobStatus) => {
      const job = baseJob({
        status: jobStatus,
        categories: [
          categoryRow({ category: "security", status: "scored", score: 78 }),
          categoryRow({ category: "testing", status: "scored", score: 60 }),
          categoryRow({ category: "maintainability", status: "running" }),
          categoryRow({ category: "architecture", status: "pending" }),
          categoryRow({ category: "documentation", status: "pending" }),
          categoryRow({ category: "performance", status: "pending" }),
        ],
      });

      const response = mapAnalysisJobToResponse(job, null);

      expect(response.status).toBe("analyzing");
      expect(response.cached).toBe(false);
      if (response.status !== "analyzing") throw new Error("unreachable");
      expect(response.progress.total).toBe(6);
      expect(response.progress.completed).toBe(2); // exactly the 2 'scored' rows above
      expect(response.progress.categories).toHaveLength(6);
      expect(response.progress.categories.find((c) => c.category === "security")).toEqual({
        category: "security",
        status: "scored",
        score: 78,
      });
    },
  );

  it("'completed' maps to response status 'completed' with the full result populated", () => {
    const scan = repoScan({ status: "complete" });
    const job = baseJob({ status: "completed", repoScanId: scan.id });

    const response = mapAnalysisJobToResponse(job, scan);

    expect(response.status).toBe("completed");
    if (response.status === "analyzing" || response.status === "failed") throw new Error("unreachable");
    expect(response.result).toBe(scan);
  });

  it("'completed_partial' maps to response status 'completed_partial' with the partial result populated", () => {
    const scan = repoScan({ status: "partial", completeness: 5 / 6 });
    const job = baseJob({ status: "completed_partial", repoScanId: scan.id });

    const response = mapAnalysisJobToResponse(job, scan);

    expect(response.status).toBe("completed_partial");
    if (response.status === "analyzing" || response.status === "failed") throw new Error("unreachable");
    expect(response.result.status).toBe("partial");
  });

  it("'failed' maps to response status 'failed' with no result field", () => {
    const job = baseJob({ status: "failed", errorCode: "BELOW_THRESHOLD" });

    const response = mapAnalysisJobToResponse(job, null);

    expect(response.status).toBe("failed");
    expect("result" in response).toBe(false);
  });
});
