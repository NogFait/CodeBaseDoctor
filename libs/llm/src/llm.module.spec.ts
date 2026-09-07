import { Global, Inject, Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { LLM_JUDGE_PORT, type JudgeRequest, type LLMJudgePort } from "@cbd/analysis";
import { ScriptedJudge } from "../testing/scripted-judge";
import { AnthropicJudgeAdapter } from "./anthropic-judge-adapter";
import { StubJudgeAdapter } from "./stub-judge-adapter";
import { selectJudge } from "./llm.module";

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
      model: "claude-sonnet-5",
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

/**
 * verify WARNING 2 — `selectJudge()` must not silently bind the offline
 * stub in a production deploy that merely forgot `ANTHROPIC_API_KEY`.
 * One row per line of the target table in the change's verify report.
 * `env` is always passed explicitly so no test mutates global
 * `process.env`, mirroring `resolveActorSaltSecret()`'s spec.
 */
describe("selectJudge (env-driven LLM judge binding)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("LLM_JUDGE=stub -> StubJudgeAdapter, and warns that scores are fake (explicit opt-in)", () => {
    const judge = selectJudge({ LLM_JUDGE: "stub" } as NodeJS.ProcessEnv);

    expect(judge).toBeInstanceOf(StubJudgeAdapter);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/LLM_JUDGE=stub/);
    expect(warn.mock.calls[0][0]).toMatch(/fabricated|fake/i);
  });

  it("LLM_JUDGE=stub still wins even when ANTHROPIC_API_KEY is present", () => {
    const judge = selectJudge({ LLM_JUDGE: "stub", ANTHROPIC_API_KEY: "sk-ant-xxx" } as NodeJS.ProcessEnv);

    expect(judge).toBeInstanceOf(StubJudgeAdapter);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("LLM_JUDGE=anthropic -> AnthropicJudgeAdapter even with no key set (SDK resolves the key lazily)", () => {
    const judge = selectJudge({ LLM_JUDGE: "anthropic" } as NodeJS.ProcessEnv);

    expect(judge).toBeInstanceOf(AnthropicJudgeAdapter);
    expect(warn).not.toHaveBeenCalled();
  });

  it("LLM_JUDGE unset + ANTHROPIC_API_KEY present -> AnthropicJudgeAdapter, silently (unchanged)", () => {
    const judge = selectJudge({ ANTHROPIC_API_KEY: "sk-ant-xxx" } as NodeJS.ProcessEnv);

    expect(judge).toBeInstanceOf(AnthropicJudgeAdapter);
    expect(warn).not.toHaveBeenCalled();
  });

  it("LLM_JUDGE unset + no key + NODE_ENV != production -> StubJudgeAdapter with a loud fallback warn", () => {
    const judge = selectJudge({ NODE_ENV: "development" } as NodeJS.ProcessEnv);

    expect(judge).toBeInstanceOf(StubJudgeAdapter);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][0] as string;
    expect(line).toMatch(/LLM_JUDGE/);
    expect(line).toMatch(/ANTHROPIC_API_KEY/);
    expect(line).toMatch(/fabricated|fake/i);
    // tells the operator how to make it stop
    expect(line).toMatch(/LLM_JUDGE=stub/);
  });

  it("test env (NODE_ENV=test, no key, LLM_JUDGE unset) -> StubJudgeAdapter + warn, never a throw (the shape worker.module.spec compiles under)", () => {
    const judge = selectJudge({ NODE_ENV: "test" } as NodeJS.ProcessEnv);

    expect(judge).toBeInstanceOf(StubJudgeAdapter);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("LLM_JUDGE unset + no key + NODE_ENV=production -> THROWS at factory time, naming both env vars (fail-fast, no fake scores in prod)", () => {
    expect(() => selectJudge({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/LLM_JUDGE/);
    expect(() => selectJudge({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("an unrecognised LLM_JUDGE value with no key behaves like unset: warn+stub in dev, throw in prod", () => {
    expect(selectJudge({ LLM_JUDGE: "garbage", NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBeInstanceOf(
      StubJudgeAdapter,
    );
    expect(() => selectJudge({ LLM_JUDGE: "garbage", NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow();
  });
});
