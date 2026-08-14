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
  findById(id: string): Promise<RepoScan | null>;
  /** History; sorted newest-first. UI deferred. */
  listByRepo(repoUrl: string, limit: number): Promise<readonly RepoScan[]>;
}
