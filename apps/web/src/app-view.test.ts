import { describe, expect, it } from "vitest";
import { viewFromStatusResponse, viewFromSubmitResponse } from "./app-view";
import type { AnalysisStatusResponse, RepoScan, SubmitAnalysisResponse } from "./api/types";

const quota = { tier: "free", limit: 5, remaining: 3, resetsAt: "2026-09-07T00:00:00.000Z" } as const;

function repoScan(overrides: Partial<RepoScan> = {}): RepoScan {
  return {
    id: "scan-1",
    repoUrl: "https://github.com/owner/repo",
    commitSha: "abc123",
    engineVersion: "1.0.0",
    status: "complete",
    compositeScore: 71.4,
    completeness: 1,
    dominantLanguage: "TypeScript",
    languageMix: [],
    categories: [],
    createdAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("viewFromSubmitResponse", () => {
  it("navigates to a progress view keyed by jobId on a 202 queued response", () => {
    const response: SubmitAnalysisResponse = {
      jobId: "job-1",
      status: "queued",
      commitSha: "abc123",
      pollAfterMs: 2000,
      quota,
    };

    const view = viewFromSubmitResponse("https://github.com/owner/repo", response);

    expect(view).toEqual({
      kind: "progress",
      repoUrl: "https://github.com/owner/repo",
      jobId: "job-1",
      pollAfterMs: 2000,
      quotaRemaining: 3,
    });
  });

  it("goes straight to the report view on a 200 cache-hit response, no polling", () => {
    const scan = repoScan();
    const response: SubmitAnalysisResponse = {
      jobId: null,
      status: "completed",
      cached: true,
      scanId: "scan-1",
      quota,
      result: scan,
    };

    const view = viewFromSubmitResponse("https://github.com/owner/repo", response);

    expect(view).toEqual({
      kind: "report",
      repoUrl: "https://github.com/owner/repo",
      status: "completed",
      result: scan,
      quotaRemaining: 3,
    });
  });
});

describe("viewFromStatusResponse", () => {
  it("maps a terminal completed_partial status to a report view with its result", () => {
    const scan = repoScan({ status: "partial", compositeScore: 60 });
    const response: AnalysisStatusResponse = {
      jobId: "job-1",
      status: "completed_partial",
      cached: false,
      result: scan,
    };

    const view = viewFromStatusResponse("https://github.com/owner/repo", response);

    expect(view).toEqual({
      kind: "report",
      repoUrl: "https://github.com/owner/repo",
      status: "completed_partial",
      result: scan,
    });
  });

  it("maps a terminal failed status to a report view with a null result", () => {
    const response: AnalysisStatusResponse = { jobId: "job-1", status: "failed", cached: false };

    const view = viewFromStatusResponse("https://github.com/owner/repo", response);

    expect(view).toEqual({
      kind: "report",
      repoUrl: "https://github.com/owner/repo",
      status: "failed",
      result: null,
    });
  });

  it("carries a forwarded quotaRemaining onto the report view (the status response itself has no quota)", () => {
    const scan = repoScan();
    const response: AnalysisStatusResponse = {
      jobId: "job-1",
      status: "completed",
      cached: false,
      result: scan,
    };

    const view = viewFromStatusResponse("https://github.com/owner/repo", response, 2);

    expect(view).toEqual({
      kind: "report",
      repoUrl: "https://github.com/owner/repo",
      status: "completed",
      result: scan,
      quotaRemaining: 2,
    });
  });

  it("threads a failed response's problem+json onto the report view so ReportView can render its copy", () => {
    const response: AnalysisStatusResponse = {
      jobId: "job-1",
      status: "failed",
      cached: false,
      problem: { type: "/errors/scan-timeout", title: "Scan timed out" },
    };

    const view = viewFromStatusResponse("https://github.com/owner/repo", response);

    expect(view).toEqual({
      kind: "report",
      repoUrl: "https://github.com/owner/repo",
      status: "failed",
      result: null,
      problem: { type: "/errors/scan-timeout", title: "Scan timed out" },
    });
  });
});
