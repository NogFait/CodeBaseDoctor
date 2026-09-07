import { RescanButton } from "../rescan/RescanButton";
import { confidenceBadgeLabel } from "./confidence-badge";
import { formatProblemMessage, type ProblemDetails } from "../../api/problem-details";
import type { RepoScan, SubmitAnalysisResponse } from "../../api/types";

export interface ReportViewProps {
  repoUrl: string;
  status: "completed" | "completed_partial" | "failed";
  result: RepoScan | null;
  onRescanSubmitted: (repoUrl: string, response: SubmitAnalysisResponse) => void;
  /** Present when the failure carries an RFC 9457 problem (e.g. a poll-time
   * 504 scan-timeout) — its formatted copy replaces the generic failure
   * sentence. */
  problem?: ProblemDetails;
  /** Route back to the URL entry form (analyze a different repo). Rendered
   * on both the completed and failed screens when provided. */
  onStartOver?: () => void;
}

const startOverClass =
  "text-sm font-medium text-slate-500 underline underline-offset-2 transition hover:text-slate-900";

/** Task 7.3 — report view. Renders distinctly for all 3 terminal states
 * (report-ui spec): `completed` (6 scored cards), `completed_partial`
 * (scored cards + a retry affordance on the unscored one), and `failed`
 * (no `result` — failure message + explicit quota-refund notice). */
export function ReportView({ repoUrl, status, result, onRescanSubmitted, problem, onStartOver }: ReportViewProps) {
  if (status === "failed" || !result) {
    return (
      <section
        aria-label="Scan failed"
        className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm sm:p-8"
      >
        <h2 className="text-lg font-semibold text-red-800">Scan failed</h2>
        {problem && <p className="mt-2 text-sm font-medium text-red-800">{formatProblemMessage(problem)}</p>}
        <p className="mt-2 text-sm text-red-700">
          We couldn't complete this scan. Your quota was refunded — it doesn't count against your daily limit.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <RescanButton repoUrl={repoUrl} onSubmitted={onRescanSubmitted} label="Try again" />
          {onStartOver && (
            <button type="button" onClick={onStartOver} className={startOverClass}>
              Analyze another repo
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Scan report" className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          {status === "completed_partial" ? "Partial report" : "Report"}
        </h2>
        <p className="mt-1 text-xs text-slate-400">Composite score</p>
        <p className="mt-1 text-6xl font-bold tracking-tight text-slate-900">
          {result.compositeScore ?? "N/A"}
        </p>
        {status === "completed_partial" && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Some categories could not be scored.
          </p>
        )}
      </div>

      <ul className="grid gap-4 sm:grid-cols-2">
        {result.categories.map((categoryScore) => (
          <li
            key={categoryScore.category}
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <h3 className="text-sm font-semibold capitalize text-slate-900">{categoryScore.category}</h3>
            {categoryScore.status === "scored" ? (
              <>
                <p className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{categoryScore.score}</p>
                <p className="mt-2 text-sm text-slate-600">{categoryScore.rationale}</p>
                <span className="mt-3 inline-block rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                  {confidenceBadgeLabel(categoryScore)}
                </span>
              </>
            ) : (
              <>
                <p className="mt-2 text-sm font-medium text-amber-700">Could not be scored</p>
                <div className="mt-3">
                  <RescanButton repoUrl={repoUrl} onSubmitted={onRescanSubmitted} label="Retry" />
                </div>
              </>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-4">
        <RescanButton repoUrl={repoUrl} onSubmitted={onRescanSubmitted} label="Re-scan" />
        {onStartOver && (
          <button type="button" onClick={onStartOver} className={startOverClass}>
            Analyze another repo
          </button>
        )}
      </div>
    </section>
  );
}
