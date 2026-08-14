import type { CategoryId, JudgeRequest, JudgeVerdict, LLMJudgePort } from "@cbd/analysis";

export interface ScriptedJudgeCall {
  request: JudgeRequest;
  signal: AbortSignal;
}

/**
 * Test double for LLMJudgePort. Scripted by category: `judge()` looks up
 * `req.category` in the map supplied at construction and either returns the
 * scripted JudgeVerdict or throws the scripted Error.
 *
 * Records every call verbatim (`calls`) so a test can assert what the caller
 * actually sent on the outgoing JudgeRequest — e.g. `rubricVersion`. Note:
 * `temperature` is NOT a field of JudgeRequest per the design's exact port
 * signature (design: "The five ports" / llm-judgment spec "Fixed decoding
 * parameters") — temperature=0 is an AnthropicJudgeAdapter-internal decoding
 * parameter passed to the provider SDK, not part of the port contract. See
 * apply-progress risk notes for the deviation this creates from the
 * orchestrator's original task wording.
 */
export class ScriptedJudge implements LLMJudgePort {
  readonly calls: ScriptedJudgeCall[] = [];

  constructor(private readonly script: Map<CategoryId, JudgeVerdict | Error>) {}

  async judge(req: JudgeRequest, signal: AbortSignal): Promise<JudgeVerdict> {
    this.calls.push({ request: req, signal });

    const outcome = this.script.get(req.category);
    if (outcome === undefined) {
      throw new Error(`ScriptedJudge: no scripted outcome for category "${req.category}"`);
    }
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  }
}
