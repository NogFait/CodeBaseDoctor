import type { ProblemDetails } from "./problem-details";

/**
 * Frontend-side mirror of `apps/api`'s `POST /analyses` / `GET /analyses/:id`
 * response shapes. Deliberately duplicated here rather than imported from
 * `@cbd/analysis` — `apps/web` only talks to the API over HTTP, it has no
 * build/runtime dependency on any `@cbd/*` domain package (see
 * `libs/analysis/src/domain/types.ts` / `ports/score-repository.port.ts` /
 * `apps/api/src/analyses/get-analysis-response.ts` for the source of truth
 * these are kept in sync with).
 */

export type CategoryId =
  | "architecture"
  | "security"
  | "testing"
  | "maintainability"
  | "performance"
  | "documentation";

export type Confidence = "measured" | "estimated" | "judged";

export interface Finding {
  ruleId: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  path?: string;
  line?: number;
  message: string;
}

export interface CategoryScore {
  category: CategoryId;
  status: "scored" | "failed" | "skipped";
  /** 0-100; null unless status === 'scored'. */
  score: number | null;
  confidence: Confidence;
  /** 1.0 for all categories except Performance (0.5, reduced weight). */
  weightCap: number;
  rationale: string;
  findings: readonly Finding[];
  error?: { code: string; message: string };
  durationMs: number;
}

export interface LanguageShare {
  language: string;
  loc: number;
  share: number;
}

/** A saved `RepoScoreReport` (`RepoScan` on the backend) — `createdAt`
 * arrives as an ISO string over JSON, not a `Date`. */
export interface RepoScan {
  id: string;
  repoUrl: string;
  commitSha: string;
  engineVersion: string;
  status: "complete" | "partial";
  compositeScore: number | null;
  completeness: number;
  dominantLanguage: string | null;
  languageMix: readonly LanguageShare[];
  categories: readonly CategoryScore[];
  createdAt: string;
}

export interface QuotaInfo {
  tier: string;
  limit: number;
  remaining: number;
  resetsAt: string;
}

/** `POST /analyses` response — 202 (queued) or 200 (cache hit). */
export type SubmitAnalysisResponse =
  | { jobId: string; status: "queued"; commitSha: string; pollAfterMs: number; quota: QuotaInfo }
  | { jobId: null; status: "completed"; cached: true; scanId: string; quota: QuotaInfo; result: RepoScan };

export interface AnalysisProgressCategory {
  category: string;
  /** pending | running | scored | failed | skipped */
  status: string;
  score: number | null;
}

/** `GET /analyses/:id` response. */
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
      /**
       * Client-synthesized only: the real `GET /analyses/:id` "failed" body
       * never carries this. `ProgressView` sets it when a poll rejects with
       * an `ApiError` (e.g. a 504 `/errors/scan-timeout` problem+json) so
       * `ReportView`'s failed branch can render `formatProblemMessage` copy
       * instead of only the generic "we couldn't complete this scan" text.
       * Absent for a raw network failure (no problem+json).
       */
      problem?: ProblemDetails;
    };

/** The two terminal shapes of `AnalysisStatusResponse` — what
 * `ProgressView.onTerminal` actually hands its caller once polling stops
 * (it never fires while `status === "analyzing"`). Named explicitly rather
 * than left as `Exclude<AnalysisStatusResponse, ...>` at each call site. */
export type TerminalAnalysisStatusResponse = Extract<
  AnalysisStatusResponse,
  { status: "completed" | "completed_partial" | "failed" }
>;
