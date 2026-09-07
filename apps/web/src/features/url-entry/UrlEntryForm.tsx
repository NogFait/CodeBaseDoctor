import { useState, type FormEvent } from "react";
import { useSubmitAnalysis } from "../submit-analysis/use-submit-analysis";
import type { SubmitAnalysisResponse } from "../../api/types";

export interface UrlEntryFormProps {
  onSubmitted: (repoUrl: string, response: SubmitAnalysisResponse) => void;
}

/** Task 7.1 — repo URL entry. Submitting POSTs `/analyses`; the actual
 * navigation decision (progress view by jobId vs. straight to report on a
 * cache hit) is made by the caller from the handed-back response — see
 * `app-view.ts`.
 *
 * Submit/pending/error handling is the shared `useSubmitAnalysis` hook —
 * identical to `RescanButton`'s. */
export function UrlEntryForm({ onSubmitted }: UrlEntryFormProps) {
  const [repoUrl, setRepoUrl] = useState("");
  const { submit, pending, error } = useSubmitAnalysis(onSubmitted);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submit(repoUrl);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
    >
      <label htmlFor="repoUrl" className="block text-sm font-medium text-slate-700">
        GitHub repo URL
      </label>
      <input
        id="repoUrl"
        name="repoUrl"
        type="text"
        value={repoUrl}
        onChange={(event) => setRepoUrl(event.target.value)}
        placeholder="https://github.com/owner/repo"
        required
        className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-500 focus:ring-2 focus:ring-slate-900/10"
      />
      <button
        type="submit"
        disabled={pending}
        className="mt-4 inline-flex w-full items-center justify-center rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
      >
        {pending ? "Scanning…" : "Scan repo"}
      </button>
      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      )}
    </form>
  );
}
