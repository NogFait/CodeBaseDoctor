import { createHash } from "node:crypto";

/**
 * Shared, pure `engineVersion` computation. Extracted from
 * `RepoAnalysisService`'s original private `computeEngineVersion` (Phase 4)
 * so that BOTH call sites — `RepoAnalysisService` (worker, mapping its
 * injected `CATEGORY_ANALYZERS` live instances) and apps/api's job-
 * submission use case (mapping the static `ANALYZER_VERSIONS` manifest from
 * `@cbd/analyzers`) — call the exact same function on equivalent input,
 * guaranteeing an identical `engineVersion` for the same underlying
 * versions. If the two ever computed it differently, `ScoreRepositoryPort
 * .findCached()` cache keys would silently never match between the process
 * that checks the cache (API) and the process that writes it (worker).
 *
 * `category` is typed as `string` rather than `CategoryId` here on purpose:
 * this file lives in `domain/` (this package's own pure-data layer) and
 * must not import `CategoryId` in a way that couples it to a specific
 * caller's shape beyond "category + version pairs" — callers narrow to
 * `CategoryId` at their own boundary (see `repo-analysis.service.ts` and
 * apps/api's use case).
 *
 * Deliberate simplification carried over unchanged from the original
 * implementation: the design's full formula also folds in `appVersion` and
 * each analyzer's LLM `rubricVersion` (neither exposed by the
 * `CategoryAnalyzer` port today) — still deferred, not this batch's job.
 */
export interface AnalyzerVersionEntry {
  category: string;
  analyzerVersion: string;
}

export function computeEngineVersion(entries: readonly AnalyzerVersionEntry[]): string {
  const fingerprint = [...entries]
    .map((e) => `${e.category}:${e.analyzerVersion}`)
    .sort()
    .join("|");
  return createHash("sha256").update(fingerprint).digest("hex").slice(0, 8);
}
