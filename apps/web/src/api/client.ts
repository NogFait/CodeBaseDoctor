import type { ProblemDetails } from "./problem-details";
import type { AnalysisStatusResponse, SubmitAnalysisResponse } from "./types";

/** Configurable at build time (`.env` / CI) — defaults to same-origin so a
 * relative `/analyses` works out of the box behind a reverse proxy. */
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

/** Thrown for any non-2xx `/analyses*` response. Carries the parsed RFC 9457
 * body so callers can turn it into copy via `formatProblemMessage`. */
export class ApiError extends Error {
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.title);
    this.name = "ApiError";
    this.problem = problem;
  }
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) {
    throw new ApiError(body as ProblemDetails);
  }
  return body as T;
}

export async function submitAnalysis(
  repoUrl: string,
  options: { forceRescan?: boolean } = {},
): Promise<SubmitAnalysisResponse> {
  const response = await fetch(`${API_BASE_URL}/analyses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoUrl, forceRescan: options.forceRescan === true }),
  });
  return parseJsonOrThrow<SubmitAnalysisResponse>(response);
}

export async function getAnalysisStatus(jobId: string): Promise<AnalysisStatusResponse> {
  const response = await fetch(`${API_BASE_URL}/analyses/${jobId}`);
  return parseJsonOrThrow<AnalysisStatusResponse>(response);
}
