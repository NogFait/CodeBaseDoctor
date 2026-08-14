import { randomUUID } from "node:crypto";
import type { CacheKey, RepoScan, RepoScoreReport, ScoreRepositoryPort } from "@cbd/analysis";

function cacheKeyOf(s: { repoUrl: string; commitSha: string; engineVersion: string }): string {
  return `${s.repoUrl}@${s.commitSha}@${s.engineVersion}`;
}

/**
 * In-memory ScoreRepositoryPort test double.
 *
 * Deviation from the design's "Testing Strategy" snippet (which shows a
 * single `Map<cacheKey, RepoScan>` that a later `save()` overwrites in
 * place): that shape can't satisfy "a scan is immutable" (spec:
 * scan-persistence) or `listByRepo` history once more than one scan exists
 * for the same (repoUrl, commitSha, engineVersion) — which happens exactly
 * in the case design decision #6 describes (a partial scan cached, later
 * superseded by a complete one for the same commit). Storage here is keyed
 * by `id` instead so every save() is a genuinely new, immutable row;
 * `findCached` filters and picks among them. See apply-progress for detail.
 */
export class InMemoryScoreRepository implements ScoreRepositoryPort {
  private readonly rows = new Map<string, RepoScan>();

  async findCached(key: CacheKey): Promise<RepoScan | null> {
    const target = cacheKeyOf(key);
    const matches = [...this.rows.values()].filter(
      (s) => cacheKeyOf(s) === target && s.status === "complete",
    );
    if (matches.length === 0) return null;
    return matches.reduce((latest, s) => (s.createdAt > latest.createdAt ? s : latest));
  }

  async save(report: RepoScoreReport): Promise<RepoScan> {
    const scan: RepoScan = { ...report, id: randomUUID() };
    this.rows.set(scan.id, scan);
    return scan;
  }

  async findById(id: string): Promise<RepoScan | null> {
    return this.rows.get(id) ?? null;
  }

  async listByRepo(repoUrl: string, limit: number): Promise<readonly RepoScan[]> {
    return [...this.rows.values()]
      .filter((s) => s.repoUrl === repoUrl)
      .sort((a, b) => +b.createdAt - +a.createdAt)
      .slice(0, limit);
  }
}
