import { InvalidRepoUrlError } from "@cbd/analysis";

export interface CreateAnalysisDto {
  repoUrl: string;
  forceRescan: boolean;
}

/**
 * Minimal, explicit request-shape validation (Task E) — this repo has no
 * `class-validator`/Nest `ValidationPipe` established anywhere yet (checked:
 * zero hits in the lockfile), so this deliberately does not introduce a new
 * validation framework for one field.
 *
 * Reuses `InvalidRepoUrlError` for a missing/non-string/empty `repoUrl`
 * rather than a separate "bad request body" error type: both a malformed
 * URL string and a missing URL are the same class of client mistake from
 * the caller's point of view, and the RFC 9457 filter already maps
 * `InvalidRepoUrlError` to 400 `/errors/invalid-repo-url` — one error type,
 * one mapping, no new validation machinery.
 */
export function parseCreateAnalysisDto(body: unknown): CreateAnalysisDto {
  const raw = body as { repoUrl?: unknown; forceRescan?: unknown } | null;
  const repoUrl = raw?.repoUrl;

  if (typeof repoUrl !== "string" || repoUrl.length === 0) {
    throw new InvalidRepoUrlError(typeof repoUrl === "string" ? repoUrl : String(repoUrl ?? ""));
  }

  return { repoUrl, forceRescan: raw?.forceRescan === true };
}
