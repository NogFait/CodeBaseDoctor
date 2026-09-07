import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getAnalysisStatus, submitAnalysis } from "./client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submitAnalysis", () => {
  it("POSTs the repoUrl and forceRescan:false by default, and returns the parsed body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(202, {
        jobId: "job-1",
        status: "queued",
        commitSha: "abc123",
        pollAfterMs: 2000,
        quota: { tier: "free", limit: 5, remaining: 3, resetsAt: "2026-09-07T00:00:00.000Z" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await submitAnalysis("https://github.com/owner/repo");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/analyses$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      repoUrl: "https://github.com/owner/repo",
      forceRescan: false,
    });
    expect(result).toEqual({
      jobId: "job-1",
      status: "queued",
      commitSha: "abc123",
      pollAfterMs: 2000,
      quota: { tier: "free", limit: 5, remaining: 3, resetsAt: "2026-09-07T00:00:00.000Z" },
    });
  });

  it("passes forceRescan:true through when requested", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(202, {
        jobId: "job-2",
        status: "queued",
        commitSha: "def456",
        pollAfterMs: 2000,
        quota: { tier: "free", limit: 5, remaining: 2, resetsAt: "2026-09-07T00:00:00.000Z" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await submitAnalysis("https://github.com/owner/repo", { forceRescan: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      repoUrl: "https://github.com/owner/repo",
      forceRescan: true,
    });
  });

  it("throws an ApiError carrying the problem+json body on a non-2xx response", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        jsonResponse(400, {
          type: "/errors/invalid-repo-url",
          title: "Invalid or unsupported repo URL",
          repoUrl: "nope",
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitAnalysis("nope")).rejects.toMatchObject({
      name: "ApiError",
      problem: { type: "/errors/invalid-repo-url", repoUrl: "nope" },
    });
  });
});

describe("getAnalysisStatus", () => {
  it("GETs /analyses/:id and returns the parsed body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(202, {
        jobId: "job-1",
        status: "analyzing",
        cached: false,
        pollAfterMs: 2500,
        progress: { completed: 1, total: 6, categories: [] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getAnalysisStatus("job-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(/\/analyses\/job-1$/);
    expect(result.status).toBe("analyzing");
  });
});
