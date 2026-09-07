import { useSubmitAnalysis } from "../submit-analysis/use-submit-analysis";
import { useT } from "../../i18n";
import type { SubmitAnalysisResponse } from "../../api/types";

export interface RescanButtonProps {
  repoUrl: string;
  onSubmitted: (repoUrl: string, response: SubmitAnalysisResponse) => void;
  /** Idle-state button label. Defaults to the localized "Re-scan". */
  label?: string;
}

/** Task 7.4 — re-scan action. Re-submits `repoUrl` with `forceRescan: true`,
 * bypassing any cache hit, and hands the response to the same
 * `onSubmitted` shape `UrlEntryForm` uses so the caller can route with one
 * function (`app-view.ts`'s `viewFromSubmitResponse`). Reused both as the
 * standalone "Re-scan" action on a completed report and as the "Could not
 * be scored… Retry" affordance on a `completed_partial` category card.
 *
 * Submit/pending/error handling is the shared `useSubmitAnalysis` hook —
 * identical to `UrlEntryForm`'s. */
export function RescanButton({ repoUrl, onSubmitted, label }: RescanButtonProps) {
  const t = useT();
  const { submit, pending, error } = useSubmitAnalysis(onSubmitted);
  const idleLabel = label ?? t("report.rescan");

  return (
    <div>
      <button
        type="button"
        onClick={() => submit(repoUrl, { forceRescan: true })}
        disabled={pending}
        className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? t("report.rescanning") : idleLabel}
      </button>
      {error && (
        <p
          role="alert"
          className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      )}
    </div>
  );
}
