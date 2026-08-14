import type { CategoryAnalyzer, CategoryScore, JudgeRequest, LLMJudgePort, RepoContext } from "@cbd/analysis";

const RUBRIC_ID = "architecture-v1";
const RUBRIC_VERSION = "1.0.0";
const MAX_OUTPUT_TOKENS = 800;

const SYSTEM_PROMPT = [
  "You are a senior software architect scoring a codebase's ARCHITECTURE",
  "quality on a 0-100 scale. Consider: separation of concerns, dependency",
  "direction (do low-level details depend on high-level policy or the",
  "reverse?), module boundaries, and whether the structure would scale to",
  "a second contributor. Respond with a score and a rationale grounded in",
  "specific evidence from the provided file tree and language mix.",
].join(" ");

/** Pure — builds the user-facing half of the judge prompt from RepoContext.
 * Kept separate from the class so it's independently testable without a
 * judge double. */
export function buildArchitectureUserPrompt(ctx: RepoContext): string {
  const fileList = ctx.files
    .slice(0, 200)
    .map((f) => f.path)
    .join("\n");
  const languageMixSummary = ctx.languageMix.map((l) => `${l.language}: ${Math.round(l.share * 100)}%`).join(", ");

  return [
    `Repository: ${ctx.repoUrl} @ ${ctx.commitSha}`,
    `Dominant language: ${ctx.dominantLanguage ?? "none (mixed below threshold)"}`,
    `Language mix: ${languageMixSummary || "unknown"}`,
    `Total LOC (recognized languages): ${ctx.totalLoc}`,
    "File tree:",
    fileList,
  ].join("\n");
}

/**
 * confidence: judged — delegates entirely to LLMJudgePort. Zero direct LLM
 * SDK import; the concrete provider is swappable behind the port per
 * spec: llm-judgment "Provider-swappable adapter".
 */
export class ArchitectureAnalyzer implements CategoryAnalyzer {
  readonly category = "architecture" as const;
  readonly confidence = "judged" as const;
  readonly analyzerVersion = "architecture-1.0.0";

  constructor(private readonly judge: LLMJudgePort) {}

  async analyze(ctx: RepoContext, signal: AbortSignal): Promise<CategoryScore> {
    const startedAt = Date.now();
    const request: JudgeRequest = {
      category: this.category,
      rubricId: RUBRIC_ID,
      rubricVersion: RUBRIC_VERSION,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildArchitectureUserPrompt(ctx),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    };

    const verdict = await this.judge.judge(request, signal);

    return {
      category: this.category,
      status: "scored",
      score: verdict.score,
      confidence: this.confidence,
      weightCap: 1,
      rationale: verdict.rationale,
      findings: [],
      durationMs: Date.now() - startedAt,
    };
  }
}
