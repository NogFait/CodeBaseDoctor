import type { CategoryAnalyzer } from "../src/ports";
import type { CategoryId, CategoryScore, Confidence, RepoContext } from "../src/domain";

export interface StubAnalyzerOptions {
  category: CategoryId;
  confidence?: Confidence;
  analyzerVersion?: string;
  /** Configure exactly one of `result` / `error` — the double drives one mode at a time. */
  result?: CategoryScore;
  error?: Error;
}

interface RecordedCall {
  ctx: RepoContext;
  signal: AbortSignal;
}

/**
 * Test double for CategoryAnalyzer. Configurable to return a canned
 * CategoryScore (drives the "analyzer succeeds" orchestration path) or to
 * throw a given error (drives the "analyzer fails" -> status:'failed'
 * fan-out path). See design: "Testing Strategy".
 */
export class StubAnalyzer implements CategoryAnalyzer {
  readonly category: CategoryId;
  readonly confidence: Confidence;
  readonly analyzerVersion: string;

  readonly calls: RecordedCall[] = [];

  private readonly result?: CategoryScore;
  private readonly error?: Error;

  constructor(options: StubAnalyzerOptions) {
    this.category = options.category;
    this.confidence = options.confidence ?? "measured";
    this.analyzerVersion = options.analyzerVersion ?? "stub-1.0.0";
    this.result = options.result;
    this.error = options.error;
  }

  async analyze(ctx: RepoContext, signal: AbortSignal): Promise<CategoryScore> {
    this.calls.push({ ctx, signal });
    if (this.error) {
      throw this.error;
    }
    if (!this.result) {
      throw new Error("StubAnalyzer: configure either `result` or `error` before calling analyze()");
    }
    return this.result;
  }
}
