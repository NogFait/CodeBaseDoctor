import type { RepoScoreReport } from "../domain";

export interface CacheKey {
  repoUrl: string;
  commitSha: string;
  engineVersion: string;
}

export interface RepoScan extends RepoScoreReport {
  id: string;
}

/**
 * Port 4 — persistence. See design: "The five ports".
 */
export interface ScoreRepositoryPort {
  /** Cache hit — only matches a RepoScan with status='complete'. */
  findCached(key: CacheKey): Promise<RepoScan | null>;
  /** Immutable insert — a saved RepoScan is never updated afterward. */
  save(report: RepoScoreReport): Promise<RepoScan>;
  /**
   * Forced re-scan write (explicit user "Re-scan"). Two scans of the same
   * (repoUrl, commitSha, engineVersion) are equivalent by definition —
   * that's the whole premise of the cache key; `forceRescan` only matters
   * because the LLM judge is non-deterministic. So when a `status='complete'`
   * row already exists for the key this REFRESHES it in place (fresh data,
   * SAME id) rather than appending a row — keeping every historical
   * `analysis_job.repo_scan_id` FK valid (no `ON DELETE SET NULL` fallout)
   * and letting old and new jobs both read the refreshed verdict. When
   * nothing is cached yet it behaves as `save()`. Exists because `save()`
   * deliberately lets the `repo_scan_cache_uniq` P2002 propagate; the forced
   * path re-runs the pipeline for an unchanged repo on purpose, so it can't
   * rely on a prior `findCached()` miss.
   */
  saveForced(report: RepoScoreReport): Promise<RepoScan>;
  findById(id: string): Promise<RepoScan | null>;
  /** History; sorted newest-first. UI deferred. */
  listByRepo(repoUrl: string, limit: number): Promise<readonly RepoScan[]>;
}
