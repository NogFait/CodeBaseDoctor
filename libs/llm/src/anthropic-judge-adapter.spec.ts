import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { JudgeRequest } from "@cbd/analysis";
import { AnthropicJudgeAdapter, LLMResponseParseError } from "./anthropic-judge-adapter";

/**
 * These tests MUST NOT make real network calls to Anthropic — no
 * ANTHROPIC_API_KEY is required or used. Mocked at the SDK client boundary
 * (constructor-injected `client`), per the pattern ScriptedJudge (Phase 2)
 * establishes for LLMJudgePort test doubles, but here mocking the raw SDK
 * client rather than the port itself, since AnthropicJudgeAdapter IS the
 * LLMJudgePort implementation under test.
 */

function makeRequest(overrides: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    category: "architecture",
    rubricId: "architecture-v1",
    rubricVersion: "1.0.0",
    systemPrompt: "You are a strict architecture reviewer.",
    userPrompt: "Repo tree:\n- src/index.ts\n- src/utils.ts",
    maxOutputTokens: 1024,
    ...overrides,
  };
}

function fakeClient(createImpl: (params: unknown, options: unknown) => Promise<Partial<Anthropic.Message>>): Anthropic {
  return {
    messages: {
      create: vi.fn(createImpl),
    },
  } as unknown as Anthropic;
}

function verdictResponse(overrides: Partial<Anthropic.Message> = {}): Partial<Anthropic.Message> {
  return {
    id: "msg_test123",
    model: "claude-sonnet-5",
    stop_reason: "tool_use",
    usage: { input_tokens: 120, output_tokens: 40 } as Anthropic.Usage,
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "submit_verdict",
        input: { score: 72, rationale: "Reasonable module boundaries, some coupling in utils." },
      } as unknown as Anthropic.ToolUseBlock,
    ],
    ...overrides,
  };
}

describe("AnthropicJudgeAdapter", () => {
  it("maps a well-formed scripted tool_use response to a JudgeVerdict", async () => {
    const client = fakeClient(async () => verdictResponse());
    const adapter = new AnthropicJudgeAdapter({ client });

    const verdict = await adapter.judge(makeRequest(), new AbortController().signal);

    expect(verdict).toEqual({
      score: 72,
      rationale: "Reasonable module boundaries, some coupling in utils.",
      modelId: "claude-sonnet-5",
      promptTokens: 120,
      completionTokens: 40,
    });
  });

  it("sets temperature: 0 on the outgoing request", async () => {
    const create = vi.fn(async (_params: unknown, _options?: unknown) => verdictResponse());
    const client = { messages: { create } } as unknown as Anthropic;
    const adapter = new AnthropicJudgeAdapter({ client });

    await adapter.judge(makeRequest(), new AbortController().signal);

    expect(create).toHaveBeenCalledTimes(1);
    const [params] = create.mock.calls[0]!;
    expect((params as unknown as { temperature: number }).temperature).toBe(0);
  });

  it("includes rubricId and rubricVersion from JudgeRequest in the prompt sent", async () => {
    const create = vi.fn(async (_params: unknown, _options?: unknown) => verdictResponse());
    const client = { messages: { create } } as unknown as Anthropic;
    const adapter = new AnthropicJudgeAdapter({ client });

    await adapter.judge(
      makeRequest({ rubricId: "documentation-v2", rubricVersion: "3.4.5" }),
      new AbortController().signal,
    );

    const [params] = create.mock.calls[0]!;
    const system = (params as unknown as { system: string }).system;
    expect(system).toContain("documentation-v2");
    expect(system).toContain("3.4.5");
  });

  it("throws LLMResponseParseError, not a raw parse exception, when no tool_use block is present", async () => {
    const client = fakeClient(async () =>
      verdictResponse({ content: [{ type: "text", text: "I decline to answer." } as unknown as Anthropic.ToolUseBlock] }),
    );
    const adapter = new AnthropicJudgeAdapter({ client });

    await expect(adapter.judge(makeRequest(), new AbortController().signal)).rejects.toBeInstanceOf(
      LLMResponseParseError,
    );
  });

  it("throws LLMResponseParseError when the tool_use input is missing required fields", async () => {
    const client = fakeClient(async () =>
      verdictResponse({
        content: [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "submit_verdict",
            input: { score: 50 }, // missing rationale
          } as unknown as Anthropic.ToolUseBlock,
        ],
      }),
    );
    const adapter = new AnthropicJudgeAdapter({ client });

    await expect(adapter.judge(makeRequest(), new AbortController().signal)).rejects.toBeInstanceOf(
      LLMResponseParseError,
    );
  });

  it("throws LLMResponseParseError when score is out of the [0,100] range", async () => {
    const client = fakeClient(async () =>
      verdictResponse({
        content: [
          {
            type: "tool_use",
            id: "toolu_3",
            name: "submit_verdict",
            input: { score: 150, rationale: "..." },
          } as unknown as Anthropic.ToolUseBlock,
        ],
      }),
    );
    const adapter = new AnthropicJudgeAdapter({ client });

    await expect(adapter.judge(makeRequest(), new AbortController().signal)).rejects.toBeInstanceOf(
      LLMResponseParseError,
    );
  });

  it("forwards the AbortSignal to the SDK call", async () => {
    const create = vi.fn(async (_params: unknown, _options?: unknown) => verdictResponse());
    const client = { messages: { create } } as unknown as Anthropic;
    const adapter = new AnthropicJudgeAdapter({ client });
    const signal = new AbortController().signal;

    await adapter.judge(makeRequest(), signal);

    const [, options] = create.mock.calls[0]!;
    expect((options as unknown as { signal: AbortSignal }).signal).toBe(signal);
  });
});
