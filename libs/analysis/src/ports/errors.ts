// Port-specific errors. Pure TypeScript — adapters (Phase 3) throw these;
// the API layer (Phase 5) maps them onto RFC 9457 problem+json responses.

export class InvalidRepoUrlError extends Error {
  constructor(public readonly url: string) {
    super(`Invalid or unsupported repo URL: ${url}`);
    this.name = "InvalidRepoUrlError";
  }
}

export class RepoNotAccessibleError extends Error {
  constructor(
    public readonly url: string,
    public readonly reason: "private" | "not-found",
  ) {
    super(`Repo not accessible: ${url} (${reason})`);
    this.name = "RepoNotAccessibleError";
  }
}

export class RepoTooLargeError extends Error {
  constructor(
    public readonly limits: { maxBytes: number; maxFiles: number },
    public readonly actual: { sizeKb?: number; files?: number },
  ) {
    super("Repo exceeds ingestion size limits");
    this.name = "RepoTooLargeError";
  }
}

export class TooManyFilesError extends Error {
  constructor(
    public readonly maxFiles: number,
    public readonly actualFiles: number,
  ) {
    super(`Repo has ${actualFiles} files, exceeding the ${maxFiles}-file limit`);
    this.name = "TooManyFilesError";
  }
}

export class CloneTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Clone did not complete within ${timeoutMs}ms`);
    this.name = "CloneTimeoutError";
  }
}

/**
 * Thrown when the scanner-container step (Semgrep + OSV-Scanner) does not
 * complete within its own timeout budget — a distinct layer from
 * `CloneTimeoutError`'s clone-step budget. See design: "Timeouts are
 * layered ... container `timeout` wrapper (clone 120s, scan 300s)". Kept as
 * its own class (not an overload of `CloneTimeoutError`) so callers can
 * distinguish which ingestion phase actually failed for accurate error
 * reporting.
 */
export class ScanTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Scan did not complete within ${timeoutMs}ms`);
    this.name = "ScanTimeoutError";
  }
}

export class QuotaExceededError extends Error {
  constructor(
    public readonly actorId: string,
    public readonly limit: number,
    public readonly resetsAt: Date,
  ) {
    super(`Actor "${actorId}" exceeded the daily quota of ${limit}`);
    this.name = "QuotaExceededError";
  }
}

/**
 * Thrown by `HeadCallRateLimiterPort.checkAndRecord()` — a NEW, independent
 * gate on `RepoSourcePort.head()` call frequency, distinct from
 * `QuotaExceededError`. `QuotaExceededError` means "you're out of your daily
 * 5 free analyses"; this means "you're hitting the repo-lookup endpoint too
 * fast", a different concept entirely (`head()` runs — and can be triggered
 * — BEFORE quota is ever consumed, see `SubmitAnalysisUseCase.submit()`).
 */
export class HeadCallRateLimitExceededError extends Error {
  constructor(
    public readonly actorId: string,
    public readonly limit: number,
    public readonly resetsAt: Date,
  ) {
    super(`Actor "${actorId}" exceeded the repo-lookup rate limit of ${limit} attempts per window`);
    this.name = "HeadCallRateLimitExceededError";
  }
}
