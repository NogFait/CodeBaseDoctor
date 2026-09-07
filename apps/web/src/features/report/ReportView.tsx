import { RescanButton } from "../rescan/RescanButton";
import { confidenceBadgeLabel } from "./confidence-badge";
import { formatProblemMessage, type ProblemDetails } from "../../api/problem-details";
import { useT, CATEGORY_KEYS, labelFor } from "../../i18n";
import { rationaleText } from "../../i18n/rationale";
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
 * (no `result` — failure message + explicit quota-refund notice).
 *
 * Note: category display names are localized (`CATEGORY_KEYS`). Rationale
 * text is localized ONLY for the 4 deterministic analyzers, which emit a
 * structured `rationaleKey` + `rationaleParams` — `rationaleText` renders
 * those in the active locale. LLM categories (architecture, documentation)
 * carry no key and their `rationale` is rendered verbatim as the model
 * produced it. */
export function ReportView({ repoUrl, status, result, onRescanSubmitted, problem, onStartOver }: ReportViewProps) {
  const t = useT();

  if (status === "failed" || !result) {
    return (
      <section
        aria-label={t("report.ariaLabelFailed")}
        className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm sm:p-8"
      >
        <h2 className="text-lg font-semibold text-red-800">{t("report.failedHeading")}</h2>
        {problem && (
          <p className="mt-2 text-sm font-medium text-red-800">{formatProblemMessage(problem, t)}</p>
        )}
        <p className="mt-2 text-sm text-red-700">{t("report.failedBody")}</p>
        <div className="mt-5 flex flex-wrap items-center gap-4">
          <RescanButton repoUrl={repoUrl} onSubmitted={onRescanSubmitted} label={t("report.tryAgain")} />
          {onStartOver && (
            <button type="button" onClick={onStartOver} className={startOverClass}>
              {t("report.analyzeAnother")}
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section aria-label={t("report.ariaLabelReport")} className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          {status === "completed_partial" ? t("report.headingPartial") : t("report.heading")}
        </h2>
        <p className="mt-1 text-xs text-slate-400">{t("report.compositeScore")}</p>
        <p className="mt-1 text-6xl font-bold tracking-tight text-slate-900">
          {result.compositeScore ?? "N/A"}
        </p>
        {status === "completed_partial" && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {t("report.partialNotice")}
          </p>
        )}
      </div>

      <ul className="grid gap-4 sm:grid-cols-2">
        {result.categories.map((categoryScore) => (
          <li
            key={categoryScore.category}
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <h3 className="text-sm font-semibold text-slate-900">{labelFor(t, CATEGORY_KEYS, categoryScore.category)}</h3>
            {categoryScore.status === "scored" ? (
              <>
                <p className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{categoryScore.score}</p>
                <p className="mt-2 text-sm text-slate-600">{rationaleText(t, categoryScore)}</p>
                <span className="mt-3 inline-block rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                  {confidenceBadgeLabel(categoryScore, t)}
                </span>
              </>
            ) : (
              <>
                <p className="mt-2 text-sm font-medium text-amber-700">{t("report.categoryUnscored")}</p>
                <div className="mt-3">
                  <RescanButton repoUrl={repoUrl} onSubmitted={onRescanSubmitted} label={t("report.retry")} />
                </div>
              </>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-4">
        <RescanButton repoUrl={repoUrl} onSubmitted={onRescanSubmitted} label={t("report.rescan")} />
        {onStartOver && (
          <button type="button" onClick={onStartOver} className={startOverClass}>
            {t("report.analyzeAnother")}
          </button>
        )}
      </div>
    </section>
  );
}
