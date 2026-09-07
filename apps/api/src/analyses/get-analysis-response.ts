import type { AnalysisJobRecord } from "@cbd/persistence";
import type { RepoScan } from "@cbd/analysis";
import { mapFailedJobToProblem, type MappedProblem } from "../errors/problem-details";

/**
 * Pure `GET /analyses/:id` response mapper (Task F / task 5.2). Extracted
 * from the controller so the status-bucket/progress-count logic is directly
 * unit-testable with zero Nest/HTTP mocks — the controller's job is only to
 * fetch `AnalysisJobRecord` (+ `RepoScan` when terminal) and call this.
 *
 * The design's own `analysis-orchestration`/`analysis-api` specs collapse
 * every non-terminal `job_status` (`queued`, `resolving`, `cloning`,
 * `analyzing`, `aggregating`) into ONE response status: `"analyzing"`. Task
 * 4.4 (per-category progress persistence in the worker processor) is not
 * built yet, so `categories` will legitimately all read `'pending'` today —
 * that's expected, not a bug in this mapper.
 */

const IN_PROGRESS_JOB_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "resolving",
  "cloning",
  "analyzing",
  "aggregating",
]);

/** Matches the design's GET example (`pollAfterMs: 2500`) — distinct from
 * POST's 2000ms initial hint. */
const GET_POLL_AFTER_MS = 2500;

export interface AnalysisProgressCategory {
  category: string;
  status: string;
  score: number | null;
}

export type AnalysisStatusResponse =
  | {
      jobId: string;
      status: "analyzing";
      cached: false;
      pollAfterMs: number;
      progress: { completed: number; total: number; categories: AnalysisProgressCategory[] };
    }
  | {
      jobId: string;
      status: "completed" | "completed_partial";
      cached: false;
      result: RepoScan;
    }
  | {
      jobId: string;
      status: "failed";
      cached: false;
      /** Present only when the failure cause is one `mapFailedJobToProblem`
       * recognizes (currently: a clone/scan timeout) — see its doc comment
       * in problem-details.ts. The controller (analyses.controller.ts)
       * uses this to return a proper RFC 9457 response (504
       * /errors/scan-timeout) instead of the bare fallback below. Absent
       * for every other failure cause (e.g. BELOW_THRESHOLD). */
      problem?: MappedProblem;
    };

export function mapAnalysisJobToResponse(job: AnalysisJobRecord, scan: RepoScan | null): AnalysisStatusResponse {
  if (IN_PROGRESS_JOB_STATUSES.has(job.status)) {
    const categories: AnalysisProgressCategory[] = job.categories.map((c) => ({
      category: c.category,
      status: c.status,
      score: c.score,
    }));
    const completed = categories.filter((c) => c.status === "scored").length;
    return {
      jobId: job.id,
      status: "analyzing",
      cached: false,
      pollAfterMs: GET_POLL_AFTER_MS,
      progress: { completed, total: categories.length, categories },
    };
  }

  if (job.status === "completed" || job.status === "completed_partial") {
    if (!scan) {
      // A completed job always has a repoScanId by construction
      // (RepoAnalysisService only marks a job completed after
      // scores.save() succeeds) — never fabricate a result if this
      // invariant is somehow violated.
      throw new Error(`AnalysisJob "${job.id}" is '${job.status}' but no RepoScan was found`);
    }
    return { jobId: job.id, status: job.status, cached: false, result: scan };
  }

  // job.status === 'failed' (the only remaining JobStatus value)
  const problem = mapFailedJobToProblem(job.errorCode, job.errorMessage);
  return problem
    ? { jobId: job.id, status: "failed", cached: false, problem }
    : { jobId: job.id, status: "failed", cached: false };
}
