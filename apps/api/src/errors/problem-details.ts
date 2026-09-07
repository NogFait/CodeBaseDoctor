import { HttpException } from "@nestjs/common";
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

/**
 * RFC 9457 (`application/problem+json`) error mapping (Task F / task 5.3).
 * Pure function — no Nest/Express types here — so the mapping table is
 * unit-testable directly; `ProblemDetailsFilter` is the thin Nest adapter
 * that calls this and writes the HTTP response.
 *
 * Placeholder value, not a real page yet: `upgradeUrl` — MVP has no billing
 * flow; documented here rather than silently hardcoded elsewhere.
 */
const UPGRADE_URL = process.env.UPGRADE_URL ?? "https://codebasedoctor.dev/pricing";

export interface MappedProblem {
  status: number;
  type: string;
  title: string;
  extra?: Record<string, unknown>;
  headers?: Record<string, string>;
}

function retryAfterSeconds(resetsAt: Date): string {
  const seconds = Math.ceil((resetsAt.getTime() - Date.now()) / 1000);
  return String(Math.max(seconds, 0));
}

export function mapErrorToProblem(error: unknown): MappedProblem {
  if (error instanceof InvalidRepoUrlError) {
    return {
      status: 400,
      type: "/errors/invalid-repo-url",
      title: "Invalid or unsupported repo URL",
      extra: { repoUrl: error.url },
    };
  }

  if (error instanceof RepoNotAccessibleError) {
    return {
      status: 422,
      type: "/errors/repo-not-accessible",
      title: "Repo not accessible",
      // reason is deliberately "private" | "not-found", indistinguishable
      // unauthenticated — see RepoNotAccessibleError's own doc comment and
      // spec `analysis-api`'s "Private repo" scenario.
      extra: { repoUrl: error.url, reason: error.reason },
    };
  }

  if (error instanceof RepoTooLargeError) {
    return {
      status: 422,
      type: "/errors/repo-too-large",
      title: "Repo exceeds ingestion size limits",
      extra: { limits: error.limits, actual: error.actual },
    };
  }

  if (error instanceof TooManyFilesError) {
    // SAME type/status as RepoTooLargeError, deliberately — see design's
    // RFC 9457 error-type table and spec `repo-ingestion`'s "Reject
    // oversized repositories" requirement: the byte-size gate and the
    // file-count gate (this one, thrown by
    // ShallowCloneAdapter.materialize()'s ls-tree count check) are one
    // "oversized repo" semantic, not two distinct error types. `maxBytes`
    // is omitted from `limits` here (unlike RepoTooLargeError's mapping) —
    // TooManyFilesError genuinely carries no byte-size information to
    // report.
    return {
      status: 422,
      type: "/errors/repo-too-large",
      title: "Repo exceeds ingestion size limits",
      extra: { limits: { maxFiles: error.maxFiles }, actual: { files: error.actualFiles } },
    };
  }

  if (error instanceof QuotaExceededError) {
    return {
      status: 429,
      type: "/errors/quota-exceeded",
      title: "Daily analysis quota exceeded",
      extra: {
        limit: error.limit,
        remaining: 0,
        resetsAt: error.resetsAt.toISOString(),
        upgradeUrl: UPGRADE_URL,
      },
      headers: { "Retry-After": retryAfterSeconds(error.resetsAt) },
    };
  }

  if (error instanceof HeadCallRateLimitExceededError) {
    // Fix C — a NEW, independent gate on RepoSourcePort.head() call
    // frequency, distinct from QuotaExceededError above: that one means
    // "you're out of your daily 5 free analyses", this one means "you're
    // hitting the repo-lookup endpoint too fast". Deliberately a DIFFERENT
    // `type` (never /errors/quota-exceeded) so a frontend/API consumer can
    // tell the two apart. `retryAfterSeconds()` reused from the
    // QuotaExceededError branch above — same "seconds until resetsAt"
    // derivation, just a much shorter window here.
    return {
      status: 429,
      type: "/errors/rate-limited",
      title: "Too many repo-lookup attempts",
      extra: { limit: error.limit, resetsAt: error.resetsAt.toISOString() },
      headers: { "Retry-After": retryAfterSeconds(error.resetsAt) },
    };
  }

  if (error instanceof ScanTimeoutError || error instanceof CloneTimeoutError) {
    // Two distinct ingestion-phase errors (see ports/errors.ts's own doc
    // comment on why clone-timeout and scan-timeout are separate classes),
    // deliberately collapsed to the SAME public error type here — same
    // "internal phase distinction the API consumer doesn't need" pattern
    // as TooManyFilesError/RepoTooLargeError above. Per spec
    // `analysis-api`'s RFC 9457 error-type table: 504 /errors/scan-timeout.
    return {
      status: 504,
      type: "/errors/scan-timeout",
      title: "Scan timed out",
      extra: { timeoutMs: error.timeoutMs },
    };
  }

  if (error instanceof HttpException) {
    // Nest's own built-in exceptions (NotFoundException for the unknown-id
    // GET /analyses/:id case, etc.) — not one of the 4 domain error types
    // this batch's spec table maps, but still a deliberate, typed HTTP
    // outcome, not an unexpected crash. Respected as-is rather than
    // flattened to 500.
    return { status: error.getStatus(), type: "about:blank", title: error.message };
  }

  // Default: generic 500, `about:blank` per RFC 9457 §4.2.1 ("no other
  // information than the HTTP status code"). Never leaks internal error
  // details into the response body.
  return { status: 500, type: "about:blank", title: "Internal server error" };
}

/** Matches the trailing `${timeoutMs}ms` that both ScanTimeoutError's and
 * CloneTimeoutError's own `Error.message` template embed (see
 * ports/errors.ts) — the only place the numeric timeout budget survives
 * once a job has failed, since `AnalysisJobRecord` persists only
 * `errorCode`/`errorMessage` strings (see describeError() in
 * libs/jobs/src/analysis-processor.ts), not a dedicated column. */
const TIMEOUT_MS_PATTERN = /(\d+)ms\b/;

/**
 * Reconstructs the RFC 9457 problem for a job that failed ASYNCHRONOUSLY
 * (inside `AnalysisProcessor.process()`, libs/jobs) purely from its
 * persisted `errorCode`/`errorMessage` columns. Unlike `mapErrorToProblem`
 * above — which maps a live, synchronously-thrown Error instance (the
 * `POST /analyses` path) — `GET /analyses/:id` never has that instance; it
 * only has what `describeError()` wrote onto the job row (`error.name` /
 * `error.message`). This reconstructs a real `ScanTimeoutError` /
 * `CloneTimeoutError` from those two strings and funnels it back through
 * `mapErrorToProblem` so both paths share ONE mapping table.
 *
 * Returns `null` for every other failure cause (e.g.
 * `AnalysisBelowThresholdError`'s `'BELOW_THRESHOLD'` code, or an
 * unrecognized error) — callers (see get-analysis-response.ts) fall back to
 * the bare `{jobId, status:'failed', cached:false}` shape for those,
 * unchanged from before this function existed.
 */
export function mapFailedJobToProblem(errorCode: string | null, errorMessage: string | null): MappedProblem | null {
  if (errorCode !== ScanTimeoutError.name && errorCode !== CloneTimeoutError.name) {
    return null;
  }

  const match = errorMessage ? TIMEOUT_MS_PATTERN.exec(errorMessage) : null;
  if (!match) return null;
  const timeoutMs = Number(match[1]);

  const reconstructed =
    errorCode === ScanTimeoutError.name ? new ScanTimeoutError(timeoutMs) : new CloneTimeoutError(timeoutMs);
  return mapErrorToProblem(reconstructed);
}
