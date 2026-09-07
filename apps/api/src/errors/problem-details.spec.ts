import { NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  CloneTimeoutError,
  HeadCallRateLimitExceededError,
  InvalidRepoUrlError,
  QuotaExceededError,
  RepoNotAccessibleError,
  RepoTooLargeError,
  ScanTimeoutError,
  TooManyFilesError,
} from "@cbd/analysis";
import { mapErrorToProblem, mapFailedJobToProblem } from "./problem-details";

describe("mapErrorToProblem", () => {
  it("maps InvalidRepoUrlError to 400 /errors/invalid-repo-url with the offending repoUrl", () => {
    const mapped = mapErrorToProblem(new InvalidRepoUrlError("ftp://not-github.example"));
    expect(mapped.status).toBe(400);
    expect(mapped.type).toBe("/errors/invalid-repo-url");
    expect(mapped.extra).toMatchObject({ repoUrl: "ftp://not-github.example" });
  });

  it("maps RepoNotAccessibleError to 422 /errors/repo-not-accessible with repoUrl and reason", () => {
    const mapped = mapErrorToProblem(new RepoNotAccessibleError("https://github.com/o/r", "private"));
    expect(mapped.status).toBe(422);
    expect(mapped.type).toBe("/errors/repo-not-accessible");
    expect(mapped.extra).toMatchObject({ repoUrl: "https://github.com/o/r", reason: "private" });
  });

  it("maps RepoTooLargeError to 422 /errors/repo-too-large with limits and actual", () => {
    const mapped = mapErrorToProblem(
      new RepoTooLargeError({ maxBytes: 500_000_000, maxFiles: 50_000 }, { sizeKb: 900_000 }),
    );
    expect(mapped.status).toBe(422);
    expect(mapped.type).toBe("/errors/repo-too-large");
    expect(mapped.extra).toMatchObject({
      limits: { maxBytes: 500_000_000, maxFiles: 50_000 },
      actual: { sizeKb: 900_000 },
    });
  });

  it("maps QuotaExceededError to 429 /errors/quota-exceeded with limit/remaining/resetsAt/upgradeUrl and a Retry-After header", () => {
    const resetsAt = new Date(Date.now() + 3600_000);
    const mapped = mapErrorToProblem(new QuotaExceededError("actor-1", 5, resetsAt));
    expect(mapped.status).toBe(429);
    expect(mapped.type).toBe("/errors/quota-exceeded");
    expect(mapped.extra).toMatchObject({ limit: 5, remaining: 0 });
    expect(mapped.extra?.resetsAt).toBe(resetsAt.toISOString());
    expect(typeof mapped.extra?.upgradeUrl).toBe("string");
    expect(mapped.headers?.["Retry-After"]).toBeDefined();
    const retryAfterSeconds = Number(mapped.headers?.["Retry-After"]);
    expect(retryAfterSeconds).toBeGreaterThan(3500);
    expect(retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  it("clamps Retry-After to 0 for an already-past resetsAt (never a negative header value)", () => {
    const mapped = mapErrorToProblem(new QuotaExceededError("actor-1", 5, new Date(Date.now() - 1000)));
    expect(mapped.headers?.["Retry-After"]).toBe("0");
  });

  it("maps TooManyFilesError to the SAME 422 /errors/repo-too-large type as RepoTooLargeError (task 8.4 gap check)", () => {
    // Per spec `repo-ingestion`'s "Reject oversized repositories" requirement,
    // the 500MB-or-more byte gate (RepoTooLargeError) and the 50k-files gate
    // (TooManyFilesError, thrown by ShallowCloneAdapter.materialize()'s
    // ls-tree count check — see shallow-clone-adapter.ts) are meant to
    // surface as the SAME "oversized repo" semantic, not two distinct error
    // types. Before this test, only RepoTooLargeError was mapped here —
    // TooManyFilesError fell through to the generic 500 branch.
    const mapped = mapErrorToProblem(new TooManyFilesError(50_000, 50_010));
    expect(mapped.status).toBe(422);
    expect(mapped.type).toBe("/errors/repo-too-large");
    expect(mapped.extra).toMatchObject({
      limits: { maxFiles: 50_000 },
      actual: { files: 50_010 },
    });
  });

  it("maps a Nest HttpException (e.g. NotFoundException) to its own status, not a flat 500", () => {
    const mapped = mapErrorToProblem(new NotFoundException());
    expect(mapped.status).toBe(404);
  });

  it("maps an unrecognized error to a generic 500 problem, not a crash", () => {
    const mapped = mapErrorToProblem(new Error("something unexpected"));
    expect(mapped.status).toBe(500);
    expect(mapped.type).toBe("about:blank");
  });

  it("maps ScanTimeoutError to 504 /errors/scan-timeout with timeoutMs", () => {
    const mapped = mapErrorToProblem(new ScanTimeoutError(300_000));
    expect(mapped.status).toBe(504);
    expect(mapped.type).toBe("/errors/scan-timeout");
    expect(mapped.extra).toMatchObject({ timeoutMs: 300_000 });
  });

  it("maps HeadCallRateLimitExceededError to 429 /errors/rate-limited — DISTINCT from /errors/quota-exceeded", () => {
    // Distinct concept from QuotaExceededError (the daily 5-free-analyses
    // limit): this one means "you're hitting the repo-lookup endpoint too
    // fast", a wholly separate gate (Fix C) — must map to its OWN type, not
    // reuse /errors/quota-exceeded.
    const resetsAt = new Date(Date.now() + 1_800_000);
    const mapped = mapErrorToProblem(new HeadCallRateLimitExceededError("actor-1", 20, resetsAt));
    expect(mapped.status).toBe(429);
    expect(mapped.type).toBe("/errors/rate-limited");
    expect(mapped.type).not.toBe("/errors/quota-exceeded");
    expect(mapped.extra).toMatchObject({ limit: 20 });
  });

  it("HeadCallRateLimitExceededError's Retry-After header reflects resetsAt, same derivation as quota-exceeded", () => {
    const resetsAt = new Date(Date.now() + 120_000);
    const mapped = mapErrorToProblem(new HeadCallRateLimitExceededError("actor-2", 5, resetsAt));
    expect(mapped.headers?.["Retry-After"]).toBeDefined();
    const retryAfterSeconds = Number(mapped.headers?.["Retry-After"]);
    expect(retryAfterSeconds).toBeGreaterThan(110);
    expect(retryAfterSeconds).toBeLessThanOrEqual(120);
  });

  it("maps CloneTimeoutError to the SAME 504 /errors/scan-timeout type as ScanTimeoutError", () => {
    // Deliberately the same public error type as ScanTimeoutError — same
    // "collapse distinct internal phases into one API-facing type" pattern
    // as TooManyFilesError/RepoTooLargeError above: clone-phase vs
    // scan-phase timeout is an internal distinction, not one the API
    // consumer needs to react to differently.
    const mapped = mapErrorToProblem(new CloneTimeoutError(120_000));
    expect(mapped.status).toBe(504);
    expect(mapped.type).toBe("/errors/scan-timeout");
    expect(mapped.extra).toMatchObject({ timeoutMs: 120_000 });
  });
});

describe("mapFailedJobToProblem", () => {
  // The GET /analyses/:id path never has the original thrown Error
  // instance — only the persisted `errorCode`/`errorMessage` strings
  // AnalysisProcessor's describeError() wrote onto the job row (see
  // libs/jobs/src/analysis-processor.ts). This reconstructs a problem from
  // exactly that persisted shape.
  it("reconstructs a 504 /errors/scan-timeout problem from a persisted ScanTimeoutError errorCode/errorMessage", () => {
    const problem = mapFailedJobToProblem("ScanTimeoutError", "Scan did not complete within 300000ms");
    expect(problem).not.toBeNull();
    expect(problem?.status).toBe(504);
    expect(problem?.type).toBe("/errors/scan-timeout");
    expect(problem?.extra).toMatchObject({ timeoutMs: 300_000 });
  });

  it("reconstructs a 504 /errors/scan-timeout problem from a persisted CloneTimeoutError errorCode/errorMessage", () => {
    const problem = mapFailedJobToProblem("CloneTimeoutError", "Clone did not complete within 120000ms");
    expect(problem).not.toBeNull();
    expect(problem?.status).toBe(504);
    expect(problem?.type).toBe("/errors/scan-timeout");
    expect(problem?.extra).toMatchObject({ timeoutMs: 120_000 });
  });

  it("returns null for a non-timeout failure cause (e.g. BELOW_THRESHOLD), so callers keep their existing fallback", () => {
    expect(mapFailedJobToProblem("BELOW_THRESHOLD", "only 3/6 categories scored")).toBeNull();
  });

  it("returns null when errorCode is null (no failure recorded yet)", () => {
    expect(mapFailedJobToProblem(null, null)).toBeNull();
  });
});
