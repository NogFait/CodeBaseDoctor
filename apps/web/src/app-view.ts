import type { ProblemDetails } from "./api/problem-details";
import type { RepoScan, SubmitAnalysisResponse, TerminalAnalysisStatusResponse } from "./api/types";

export type View =
  | { kind: "entry" }
  | { kind: "progress"; repoUrl: string; jobId: string; pollAfterMs: number; quotaRemaining?: number }
  | {
      kind: "report";
      repoUrl: string;
      status: "completed" | "completed_partial" | "failed";
      result: RepoScan | null;
      /** Set only on a `failed` view reached from a poll-time `ApiError`
       * (e.g. 504 scan-timeout) — lets `ReportView` show `formatProblemMessage`
       * copy instead of the generic failure text. */
      problem?: ProblemDetails;
      /** Daily free-tier analyses left, from the `POST /analyses` response's
       * `quota.remaining`. Carried forward from the progress view when a
       * terminal `GET /analyses/:id` response (which has no quota block)
       * transitions here. */
      quotaRemaining?: number;
    };

/**
 * Pure navigation decision for `POST /analyses` (task 7.1's "submit calls
 * POST, navigates by jobId" + report-ui spec's "on 200 cache hit, go
 * straight to the report view, no polling needed"). Kept out of App.tsx so
 * the routing decision is unit-testable without rendering anything.
 */
export function viewFromSubmitResponse(repoUrl: string, response: SubmitAnalysisResponse): View {
  if (response.status === "queued") {
    return {
      kind: "progress",
      repoUrl,
      jobId: response.jobId,
      pollAfterMs: response.pollAfterMs,
      quotaRemaining: response.quota.remaining,
    };
  }
  return {
    kind: "report",
    repoUrl,
    status: "completed",
    result: response.result,
    quotaRemaining: response.quota.remaining,
  };
}

/** Pure navigation decision for a terminal `GET /analyses/:id` response
 * (task 7.2 hands this to ProgressView's `onTerminal`). `quotaRemaining` is
 * threaded through by the caller from the progress view it's leaving — the
 * status response body itself carries no quota block. */
export function viewFromStatusResponse(
  repoUrl: string,
  response: TerminalAnalysisStatusResponse,
  quotaRemaining?: number,
): View {
  if (response.status === "failed") {
    return { kind: "report", repoUrl, status: "failed", result: null, problem: response.problem, quotaRemaining };
  }
  return { kind: "report", repoUrl, status: response.status, result: response.result, quotaRemaining };
}
