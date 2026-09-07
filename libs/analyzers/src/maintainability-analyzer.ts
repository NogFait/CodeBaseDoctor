import type { CategoryAnalyzer, CategoryScore, RepoContext, RepoFile } from "@cbd/analysis";

/** Files over this many lines count against the score. Deliberately a
 * simple, single heuristic for MVP — not a real complexity/coupling
 * parser (design: "keep it honest and simple for MVP, don't over-engineer
 * a full complexity parser"). */
const OVERSIZED_FILE_LOC = 300;

/** Pure — penalizes the SHARE of recognized-language files that are
 * oversized. Simple and legible on purpose: this is a proxy for
 * maintainability, not a ground truth. */
export function scoreFromFileSizes(files: readonly RepoFile[]): { score: number; oversizedCount: number; recognizedCount: number } {
  const recognized = files.filter((f) => f.language !== null);
  const oversized = recognized.filter((f) => f.loc > OVERSIZED_FILE_LOC);
  if (recognized.length === 0) {
    return { score: 100, oversizedCount: 0, recognizedCount: 0 };
  }
  const oversizedRatio = oversized.length / recognized.length;
  const score = Math.round(100 - oversizedRatio * 100);
  return { score: Math.max(0, Math.min(100, score)), oversizedCount: oversized.length, recognizedCount: recognized.length };
}

/**
 * confidence: measured — a single, honest heuristic (share of oversized
 * files) over RepoContext.files. See spec: category-scoring.
 */
export class MaintainabilityAnalyzer implements CategoryAnalyzer {
  readonly category = "maintainability" as const;
  readonly confidence = "measured" as const;
  readonly analyzerVersion = "maintainability-1.0.0";

  async analyze(ctx: RepoContext, _signal: AbortSignal): Promise<CategoryScore> {
    const startedAt = Date.now();
    const { score, oversizedCount, recognizedCount } = scoreFromFileSizes(ctx.files);

    return {
      category: this.category,
      status: "scored",
      score,
      confidence: this.confidence,
      weightCap: 1,
      rationale: `${oversizedCount} oversized file${oversizedCount === 1 ? "" : "s"} (>${OVERSIZED_FILE_LOC} LOC) out of ${recognizedCount} recognized-language file${recognizedCount === 1 ? "" : "s"}.`,
      rationaleKey: "rationale.maintainability",
      rationaleParams: { oversized: oversizedCount, loc: OVERSIZED_FILE_LOC, recognized: recognizedCount },
      findings: [],
      durationMs: Date.now() - startedAt,
    };
  }
}
