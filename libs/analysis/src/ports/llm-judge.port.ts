import type { CategoryId } from "../domain";

export interface JudgeRequest {
  category: CategoryId;
  rubricId: string;
  rubricVersion: string;
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens: number;
}

export interface JudgeVerdict {
  score: number;
  rationale: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Port 3 — LLM judgment. The ONLY component in the system that talks to an
 * LLM provider. Concrete adapters call at temperature 0, JSON-schema
 * constrained output — that is an adapter-internal decoding parameter, not a
 * field of JudgeRequest (see apply-progress risk notes).
 * See design: "The five ports".
 */
export interface LLMJudgePort {
  judge(req: JudgeRequest, signal: AbortSignal): Promise<JudgeVerdict>;
}
