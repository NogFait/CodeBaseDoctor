import type { JudgeVerdict } from "@cbd/analysis";

/**
 * Reusable, deterministic scripted verdicts for the Architecture and
 * Documentation categories — the two `LLMJudgePort`-backed analyzers. Any
 * E2E scenario that expects a normal `'scored'` outcome for these
 * categories (not a deliberately scripted failure) can reuse these instead
 * of re-typing an ad-hoc `JudgeVerdict` literal per test file.
 */
export const DEFAULT_ARCHITECTURE_VERDICT: JudgeVerdict = {
  score: 82,
  rationale: "Clear module boundaries and sensible dependency direction for a repo this size.",
  modelId: "scripted-judge",
  promptTokens: 0,
  completionTokens: 0,
};

export const DEFAULT_DOCUMENTATION_VERDICT: JudgeVerdict = {
  score: 74,
  rationale: "A README is present and explains what the project does and how to run it.",
  modelId: "scripted-judge",
  promptTokens: 0,
  completionTokens: 0,
};
