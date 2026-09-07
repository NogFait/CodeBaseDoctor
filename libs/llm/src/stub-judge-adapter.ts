import type { CategoryId, JudgeRequest, JudgeVerdict, LLMJudgePort } from "@cbd/analysis";

/**
 * StubJudgeAdapter — a FREE, fully-offline LLMJudgePort for the local dev
 * harness (see DEV-HARNESS.md). Costs nothing: no network, no Anthropic SDK,
 * no ANTHROPIC_API_KEY. `LlmModule` selects it when `LLM_JUDGE=stub` (or when
 * neither `LLM_JUDGE` nor `ANTHROPIC_API_KEY` is set), so the whole stack can
 * run one real repo analysis end-to-end without spending a token.
 *
 * Verdicts are:
 *  - deterministic — the same JudgeRequest always yields the same verdict, so
 *    a re-scan of the same repo/commit reproduces identically;
 *  - pseudo-varied per category — each of the six categories lands in its own
 *    non-overlapping score lane (55-90), so a rendered report shows six
 *    distinct cards rather than one number repeated.
 *
 * `failCategories` (constructor option, or the `STUB_JUDGE_FAIL_CATEGORIES`
 * env var as a comma-separated list) makes `judge()` throw for those
 * categories — a cheap way to drive the `completed_partial` (1 failure) and
 * `failed` (4+ failures) report states in the harness without a real LLM
 * outage.
 */

const MODEL_ID = "stub-judge";

// Fixed lane order. Each category owns a 6-point slice of the 55-90 band:
// architecture 55-60, security 61-66, testing 67-72, maintainability 73-78,
// performance 79-84, documentation 85-90. Non-overlapping => scores are
// always distinct across categories; the hash only varies the value WITHIN
// a lane so it still reacts to `category` + `rubricId`.
const LANE_ORDER: readonly CategoryId[] = [
  "architecture",
  "security",
  "testing",
  "maintainability",
  "performance",
  "documentation",
];

const LANE_WIDTH = 6;
const LANE_BASE = 55;

/** djb2 — small, stable, dependency-free string hash. */
function hashString(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  // Coerce to an unsigned 32-bit int.
  return hash >>> 0;
}

function parseFailCategories(raw: string | undefined): Set<CategoryId> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((part) => part.trim())
      .filter((part): part is CategoryId => (LANE_ORDER as readonly string[]).includes(part)),
  );
}

export interface StubJudgeAdapterOptions {
  /**
   * Categories for which `judge()` should throw. Overrides
   * `STUB_JUDGE_FAIL_CATEGORIES` when provided (even as an empty list).
   */
  failCategories?: Iterable<CategoryId>;
}

export class StubJudgeAdapter implements LLMJudgePort {
  private readonly failCategories: Set<CategoryId>;

  constructor(options: StubJudgeAdapterOptions = {}) {
    this.failCategories =
      options.failCategories !== undefined
        ? new Set(options.failCategories)
        : parseFailCategories(process.env.STUB_JUDGE_FAIL_CATEGORIES);
  }

  async judge(req: JudgeRequest, signal: AbortSignal): Promise<JudgeVerdict> {
    // Mirror AnthropicJudgeAdapter's contract: an already-aborted signal
    // must abort the call. `throwIfAborted()` throws the signal's reason
    // (a DOMException "AbortError" by default).
    signal?.throwIfAborted();

    if (this.failCategories.has(req.category)) {
      throw new Error(
        `[stub judge] forced failure for category "${req.category}" (STUB_JUDGE_FAIL_CATEGORIES / failCategories)`,
      );
    }

    const laneIndex = Math.max(0, LANE_ORDER.indexOf(req.category));
    const withinLane = hashString(`${req.category}::${req.rubricId}`) % LANE_WIDTH;
    const score = LANE_BASE + laneIndex * LANE_WIDTH + withinLane;

    return {
      score,
      rationale:
        `[stub verdict] The ${req.category} dimension shows a mix of strengths and gaps; ` +
        `this rationale is generated offline by StubJudgeAdapter without an LLM.`,
      modelId: MODEL_ID,
      promptTokens: 0,
      completionTokens: 0,
    };
  }
}
