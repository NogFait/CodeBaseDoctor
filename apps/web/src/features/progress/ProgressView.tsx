import { useEffect, useRef, useState } from "react";
import { ApiError, getAnalysisStatus } from "../../api/client";
import { useT, CATEGORY_KEYS, labelFor, type MessageKey } from "../../i18n";
import type { ProblemDetails } from "../../api/problem-details";
import type { AnalysisProgressCategory, TerminalAnalysisStatusResponse } from "../../api/types";

const STATUS_KEYS: Record<string, MessageKey> = {
  pending: "progress.status.pending",
  running: "progress.status.running",
  scored: "progress.status.scored",
  failed: "progress.status.failed",
  skipped: "progress.status.skipped",
};

/** Built for any poll rejection — an `ApiError` (any non-2xx problem+json,
 * including the 504 scan-timeout terminal case) or a raw network failure
 * alike. Reuses the exact "failed" shape `ReportView`'s existing failed-case
 * UI (message + quota-refund notice) already renders — see `app-view.ts`'s
 * `viewFromStatusResponse`. We deliberately don't distinguish error causes
 * here: any poll failure ends the loop rather than hanging or retrying
 * silently forever. When the rejection is an `ApiError` we keep its
 * problem+json so `ReportView` can show the specific copy (e.g. the 504
 * scan-timeout message) rather than only the generic failure text; a raw
 * network failure carries no `problem` and keeps the generic copy. */
function toFailedTerminalResponse(jobId: string, problem?: ProblemDetails): TerminalAnalysisStatusResponse {
  return { jobId, status: "failed", cached: false, problem };
}

export interface ProgressViewProps {
  jobId: string;
  /** Initial poll delay, from the enqueue response (or a caller-provided
   * fallback when navigated to directly). */
  pollAfterMs: number;
  onTerminal: (response: TerminalAnalysisStatusResponse) => void;
}

interface ProgressState {
  completed: number;
  total: number;
  categories: readonly AnalysisProgressCategory[];
}

/** Task 7.2 — progress view. Polls `GET /analyses/:id` every `pollAfterMs`
 * (re-reading the server's own `pollAfterMs` on each non-terminal response,
 * not a fixed client-side interval) until a terminal status, rendering
 * per-category state as it changes. */
export function ProgressView({ jobId, pollAfterMs, onTerminal }: ProgressViewProps) {
  const t = useT();
  const [progress, setProgress] = useState<ProgressState | null>(null);
  // Keeps the effect's poll loop from needing `onTerminal` in its dep array
  // — a new callback identity on every parent render must NOT restart the
  // whole polling timer.
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      let response;
      try {
        response = await getAnalysisStatus(jobId);
      } catch (err) {
        // Any non-2xx problem+json (ApiError — includes the 504 scan-timeout
        // terminal case) or raw network failure: stop polling and surface
        // the existing "failed" UI rather than leaving an unhandled
        // rejection and a stuck "Scanning repository…" screen. An ApiError
        // keeps its problem+json so the failed screen can show the specific
        // message; a bare network error does not.
        if (!cancelled) {
          const problem = err instanceof ApiError ? err.problem : undefined;
          onTerminalRef.current(toFailedTerminalResponse(jobId, problem));
        }
        return;
      }
      if (cancelled) {
        return;
      }
      if (response.status === "analyzing") {
        setProgress(response.progress);
        timer = setTimeout(poll, response.pollAfterMs);
      } else {
        onTerminalRef.current(response);
      }
    }

    timer = setTimeout(poll, pollAfterMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId, pollAfterMs]);

  return (
    <section
      aria-label={t("progress.ariaLabel")}
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
    >
      <h2 className="flex items-center gap-2.5 text-lg font-semibold text-slate-900">
        <span
          aria-hidden="true"
          className="inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-500"
        />
        {t("progress.heading")}
      </h2>
      {progress ? (
        <ul className="mt-5 divide-y divide-slate-100 border-t border-slate-100">
          {progress.categories.map((category) => (
            <li
              key={category.category}
              className="py-2.5 font-mono text-sm text-slate-600"
            >
              {/* Keep name + status as direct text of this single <li> — a
                  `getByText("security: running")`-style query only joins an
                  element's direct text-node children, not nested spans. */}
              {labelFor(t, CATEGORY_KEYS, category.category)}: {labelFor(t, STATUS_KEYS, category.status)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 animate-pulse text-sm text-slate-500">{t("progress.starting")}</p>
      )}
    </section>
  );
}
