import { useState } from "react";
import { ApiError, submitAnalysis } from "../../api/client";
import { formatProblemMessage } from "../../api/problem-details";
import type { SubmitAnalysisResponse } from "../../api/types";

/** Generic "we couldn't map this to a known problem type" copy — shown for a
 * raw network failure or any non-`ApiError` throw. */
const GENERIC_ERROR = "Something went wrong. Please try again.";

export interface UseSubmitAnalysis {
  /** Fire a `POST /analyses`. On success calls `onSubmitted(repoUrl,
   * response)`; on failure sets `error` and does NOT call `onSubmitted`. */
  submit: (repoUrl: string, options?: { forceRescan?: boolean }) => Promise<void>;
  /** True while a `submit` call is in flight. */
  pending: boolean;
  /** User-facing error copy from the last failed `submit`, or `null`. */
  error: string | null;
}

/**
 * Shared submit-an-analysis state machine for the two entry points that
 * both POST `/analyses` (`UrlEntryForm`, `RescanButton`): the `pending`
 * flag, the `ApiError → formatProblemMessage` (else generic) mapping, and
 * clearing the previous error on each new attempt. Extracted verbatim from
 * those two components — they now differ only in their markup and in
 * whether they pass `forceRescan`.
 */
export function useSubmitAnalysis(
  onSubmitted: (repoUrl: string, response: SubmitAnalysisResponse) => void,
): UseSubmitAnalysis {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(repoUrl: string, options: { forceRescan?: boolean } = {}): Promise<void> {
    setError(null);
    setPending(true);
    try {
      const response = await submitAnalysis(repoUrl, options);
      onSubmitted(repoUrl, response);
    } catch (err) {
      setError(err instanceof ApiError ? formatProblemMessage(err.problem) : GENERIC_ERROR);
    } finally {
      setPending(false);
    }
  }

  return { submit, pending, error };
}
