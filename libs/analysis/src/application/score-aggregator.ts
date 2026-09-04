import type { CategoryScore, LanguageShare, RepoScoreReport } from "../domain";

export interface AggregateRepoMeta {
  repoUrl: string;
  commitSha: string;
  engineVersion: string;
  dominantLanguage: string | null;
  languageMix: readonly LanguageShare[];
}

/**
 * Folds a fan-out's `CategoryScore[]` (always exactly 6 — `AnalyzerRunner`
 * guarantees a slot per category, scored or failed) into one
 * `RepoScoreReport`. Pure — no I/O, no ports.
 * See design decision #6 ("Partial results") and spec `analysis-orchestration`
 * / `category-scoring`.
 */
export class ScoreAggregator {
  constructor(private readonly now: () => Date = () => new Date()) {}

  aggregate(categories: readonly CategoryScore[], meta: AggregateRepoMeta): RepoScoreReport {
    const scored = categories.filter((c) => c.status === "scored");
    const totalWeight = scored.reduce((sum, c) => sum + c.weightCap, 0);
    const weightedSum = scored.reduce((sum, c) => sum + (c.score ?? 0) * c.weightCap, 0);

    return {
      repoUrl: meta.repoUrl,
      commitSha: meta.commitSha,
      engineVersion: meta.engineVersion,
      // 'complete' requires every category to have scored; 4, 5, or fewer
      // scored is always 'partial' — never claim complete on a partial
      // fan-out. Whether a scan this incomplete is even persisted is
      // RepoAnalysisService's call (>= 4-of-6 threshold), not this method's.
      status: scored.length === categories.length ? "complete" : "partial",
      compositeScore: scored.length === 0 ? null : weightedSum / totalWeight,
      completeness: categories.length === 0 ? 0 : scored.length / categories.length,
      dominantLanguage: meta.dominantLanguage,
      languageMix: meta.languageMix,
      categories,
      createdAt: this.now(),
    };
  }
}
