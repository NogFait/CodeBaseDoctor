import { Global, Inject, Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { LLM_JUDGE_PORT, type JudgeRequest, type LLMJudgePort } from "@cbd/analysis";
import { ScriptedJudge } from "../testing/scripted-judge";
import { AnthropicJudgeAdapter } from "./anthropic-judge-adapter";

/**
 * spec: llm-judgment "Provider-swappable adapter" — the concrete LLM
 * provider adapter must be swappable behind LLMJudgePort without changes to
 * any consumer. `JudgeConsumer` stands in for RepoAnalysisService/an
 * analyzer: it only knows about LLM_JUDGE_PORT, never about
 * AnthropicJudgeAdapter or ScriptedJudge directly.
 */
@Injectable()
class JudgeConsumer {
  constructor(@Inject(LLM_JUDGE_PORT) private readonly judge: LLMJudgePort) {}

  run(req: JudgeRequest, signal: AbortSignal) {
    return this.judge.judge(req, signal);
  }
}

const REQUEST: JudgeRequest = {
  category: "architecture",
  rubricId: "architecture-v1",
  rubricVersion: "1.0.0",
  systemPrompt: "You are a strict architecture reviewer.",
  userPrompt: "Repo tree:\n- src/index.ts",
  maxOutputTokens: 512,
};

describe("LLMJudgePort provider swap", () => {
  it("JudgeConsumer produces the same verdict shape whether wired to ScriptedJudge or AnthropicJudgeAdapter", async () => {
    // --- Module A: bound to ScriptedJudge (Phase 2 test double) ---
    const verdict = { score: 65, rationale: "Solid layering.", modelId: "scripted", promptTokens: 0, completionTokens: 0 };
    @Global()
    @Module({
      providers: [
        { provide: LLM_JUDGE_PORT, useValue: new ScriptedJudge(new Map([["architecture", verdict]])) },
        JudgeConsumer,
      ],
      exports: [LLM_JUDGE_PORT],
    })
    class ScriptedLlmModule {}

    const scriptedModuleRef = await Test.createTestingModule({ imports: [ScriptedLlmModule] }).compile();
    const scriptedConsumer = scriptedModuleRef.get(JudgeConsumer);
    const scriptedResult = await scriptedConsumer.run(REQUEST, new AbortController().signal);

    expect(scriptedResult).toEqual(verdict);

    // --- Module B: bound to AnthropicJudgeAdapter with a fake SDK client ---
    const create = vi.fn(async () => ({
      id: "msg_swap_test",
      model: "claude-sonnet-4-6",
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        {
          type: "tool_use",
          id: "toolu_swap",
          name: "submit_verdict",
          input: { score: 65, rationale: "Solid layering." },
        },
      ],
    }));
    const fakeAnthropicClient = { messages: { create } } as unknown as Anthropic;

    @Global()
    @Module({
      providers: [
        { provide: LLM_JUDGE_PORT, useFactory: () => new AnthropicJudgeAdapter({ client: fakeAnthropicClient }) },
        JudgeConsumer,
      ],
      exports: [LLM_JUDGE_PORT],
    })
    class AnthropicLlmModule {}

    const anthropicModuleRef = await Test.createTestingModule({ imports: [AnthropicLlmModule] }).compile();
    const anthropicConsumer = anthropicModuleRef.get(JudgeConsumer);
    const anthropicResult = await anthropicConsumer.run(REQUEST, new AbortController().signal);

    // Same JudgeConsumer class, same call signature, same shape of result —
    // only score/rationale carry over identically (modelId/token counts are
    // adapter-specific, as the port contract allows).
    expect(anthropicResult.score).toBe(scriptedResult.score);
    expect(anthropicResult.rationale).toBe(scriptedResult.rationale);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
