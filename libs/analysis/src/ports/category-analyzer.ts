import type { CategoryId, CategoryScore, Confidence, RepoContext } from "../domain";

/**
 * Port 1 — one implementation per category. Adding a 7th category is a new
 * provider behind CATEGORY_ANALYZERS, zero orchestration change.
 * See design: "The five ports".
 */
export interface CategoryAnalyzer {
  readonly category: CategoryId;
  readonly confidence: Confidence;
  /** Folded into engineVersion so a prompt/heuristic edit busts the cache. */
  readonly analyzerVersion: string;
  analyze(ctx: RepoContext, signal: AbortSignal): Promise<CategoryScore>;
}
