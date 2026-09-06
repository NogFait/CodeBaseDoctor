import type { CategoryAnalyzer } from "../ports";
import type { CategoryId, CategoryScore, RepoContext } from "../domain";

/**
 * Per-category timeout budget. Security is Semgrep-backed (a real Docker
 * container scan) and gets the larger 180s budget; every other category is
 * either a single LLM call or an in-memory heuristic pass and gets 90s.
 * See design: "Ephemeral Scan Container Design" (analyzer AbortSignal layer:
 * 90s LLM / 180s Semgrep) and "one analyzer fails mid-run".
 */
export const DEFAULT_TIMEOUT_MS_BY_CATEGORY: Readonly<Record<CategoryId, number>> = {
  security: 180_000,
  testing: 90_000,
  maintainability: 90_000,
  architecture: 90_000,
  documentation: 90_000,
  performance: 90_000,
};

/**
 * `weightCap` a synthesized *failed* CategoryScore carries, mirroring spec
 * `category-scoring`'s table (Performance 0.5, everything else 1.0). This
 * never affects `ScoreAggregator`'s composite math — only `status:'scored'`
 * categories are weighted in — it exists purely so a failed slot's shape
 * matches what that category would have carried had it succeeded.
 */
const WEIGHT_CAP_BY_CATEGORY: Readonly<Record<CategoryId, number>> = {
  security: 1,
  testing: 1,
  maintainability: 1,
  architecture: 1,
  documentation: 1,
  performance: 0.5,
};

/** Thrown internally when an analyzer does not settle within its timeout budget. */
export class AnalyzerTimeoutError extends Error {
  readonly code = "ANALYZER_TIMEOUT";

  constructor(
    public readonly category: CategoryId,
    public readonly timeoutMs: number,
  ) {
    super(`Analyzer "${category}" did not complete within ${timeoutMs}ms`);
    this.name = "AnalyzerTimeoutError";
  }
}

/**
 * Emitted by `AnalyzerRunner.run()`'s optional `onProgress` callback — the
 * domain-side plumbing task 4.4 (per-category live progress) needs. A
 * caller (task 6.2's `AnalysisProcessor`) uses this to write
 * `analysis_job_category` rows as each analyzer starts and settles, without
 * `AnalyzerRunner` itself knowing anything about persistence.
 */
export type AnalyzerProgressEvent =
  | { type: "running"; category: CategoryId }
  | { type: "settled"; category: CategoryId; score: CategoryScore };

export type AnalyzerProgressCallback = (event: AnalyzerProgressEvent) => void;

export interface AnalyzerRunnerOptions {
  /**
   * Overrides `DEFAULT_TIMEOUT_MS_BY_CATEGORY` per category. Production
   * callers should rely on the defaults; this exists so tests can drive the
   * timeout path in milliseconds instead of real minutes.
   */
  timeoutMsByCategory?: Partial<Record<CategoryId, number>>;
}

/**
 * Fans a `RepoContext` out to every `CategoryAnalyzer` concurrently. An
 * analyzer never throws, rejects, or hangs the fan-out: a thrown error, a
 * rejected promise, or a timeout all become that category's own
 * `CategoryScore{status:'failed'}` — never a missing slot.
 * See design: "Rule: an analyzer never throws out of the fan-out.
 * AnalyzerRunner.run() wraps every analyze() in try/catch and always yields
 * a CategoryScore. A missing category is impossible — only a status:'failed' one."
 */
export class AnalyzerRunner {
  private readonly timeoutMsByCategory: Partial<Record<CategoryId, number>>;

  constructor(options: AnalyzerRunnerOptions = {}) {
    this.timeoutMsByCategory = options.timeoutMsByCategory ?? {};
  }

  async run(
    analyzers: readonly CategoryAnalyzer[],
    ctx: RepoContext,
    onProgress?: AnalyzerProgressCallback,
  ): Promise<CategoryScore[]> {
    const settled = await Promise.allSettled(
      analyzers.map(async (analyzer) => {
        onProgress?.({ type: "running", category: analyzer.category });
        const score = await this.runOne(analyzer, ctx);
        onProgress?.({ type: "settled", category: analyzer.category, score });
        return score;
      }),
    );
    return settled.map((outcome, index) =>
      outcome.status === "fulfilled" ? outcome.value : this.toFailedScore(analyzers[index], outcome.reason, 0),
    );
  }

  private timeoutMsFor(category: CategoryId): number {
    return this.timeoutMsByCategory[category] ?? DEFAULT_TIMEOUT_MS_BY_CATEGORY[category];
  }

  /**
   * Runs exactly one analyzer against a dedicated AbortController/timeout.
   * This itself never rejects — every failure path (thrown error, rejected
   * promise, or timeout) is caught here and turned into a failed
   * CategoryScore. The outer Promise.allSettled in `run()` is a second,
   * purely defensive safety net.
   */
  private async runOne(analyzer: CategoryAnalyzer, ctx: RepoContext): Promise<CategoryScore> {
    const controller = new AbortController();
    const timeoutMs = this.timeoutMsFor(analyzer.category);
    const startedAt = Date.now();
    let timer!: ReturnType<typeof setTimeout>;

    // Promise.race, not just an awaited call: an analyzer that ignores its
    // AbortSignal and never settles must still yield a result once its
    // budget elapses — awaiting analyze() directly would hang forever.
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AnalyzerTimeoutError(analyzer.category, timeoutMs));
      }, timeoutMs);
    });

    try {
      return await Promise.race([analyzer.analyze(ctx, controller.signal), timeoutPromise]);
    } catch (error) {
      return this.toFailedScore(analyzer, error, Date.now() - startedAt);
    } finally {
      clearTimeout(timer);
    }
  }

  private toFailedScore(analyzer: CategoryAnalyzer, error: unknown, durationMs: number): CategoryScore {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof AnalyzerTimeoutError ? error.code : "ANALYZER_ERROR";
    return {
      category: analyzer.category,
      status: "failed",
      score: null,
      confidence: analyzer.confidence,
      weightCap: WEIGHT_CAP_BY_CATEGORY[analyzer.category],
      rationale: `Not scored — the analyzer failed: ${message}`,
      findings: [],
      error: { code, message },
      durationMs,
    };
  }
}
