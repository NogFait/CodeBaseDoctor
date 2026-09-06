import { HttpException } from "@nestjs/common";
import {
  InvalidRepoUrlError,
  QuotaExceededError,
  RepoNotAccessibleError,
  RepoTooLargeError,
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
