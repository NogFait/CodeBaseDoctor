import { describe, expect, it } from "vitest";
import type { CategoryId, JudgeRequest, JudgeVerdict } from "@cbd/analysis";
import { ScriptedJudge } from "./scripted-judge";

function makeRequest(overrides: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    category: "architecture",
    rubricId: "architecture-rubric",
    rubricVersion: "v3",
    systemPrompt: "You are a senior architect reviewing a codebase.",
    userPrompt: "Rate the layering.",
    maxOutputTokens: 500,
    ...overrides,
  };
}

describe("ScriptedJudge", () => {
  it("returns the scripted verdict for the requested category", async () => {
    const verdict: JudgeVerdict = {
      score: 72,
      rationale: "Clear layering, some leaky abstractions.",
      modelId: "claude-test",
      promptTokens: 400,
      completionTokens: 120,
    };
    const judge = new ScriptedJudge(new Map<CategoryId, JudgeVerdict | Error>([["architecture", verdict]]));

    const result = await judge.judge(makeRequest({ category: "architecture" }), new AbortController().signal);

    expect(result).toBe(verdict);
  });

  it("throws the scripted error for a category scripted to fail", async () => {
    const failure = new Error("LLM_TIMEOUT");
    const judge = new ScriptedJudge(new Map<CategoryId, JudgeVerdict | Error>([["documentation", failure]]));

    await expect(
      judge.judge(makeRequest({ category: "documentation" }), new AbortController().signal),
    ).rejects.toBe(failure);
  });

  it("throws a descriptive error when a category has no scripted outcome", async () => {
    const judge = new ScriptedJudge(new Map());

    await expect(
      judge.judge(makeRequest({ category: "architecture" }), new AbortController().signal),
    ).rejects.toThrow(/no scripted outcome/);
  });

  it("records rubricVersion and category actually present on the outgoing JudgeRequest", async () => {
    const verdict: JudgeVerdict = {
      score: 55,
      rationale: "Sparse README, no ADRs.",
      modelId: "claude-test",
      promptTokens: 300,
      completionTokens: 90,
    };
    const judge = new ScriptedJudge(new Map<CategoryId, JudgeVerdict | Error>([["documentation", verdict]]));
    const req = makeRequest({ category: "documentation", rubricVersion: "v7-doc" });
    const signal = new AbortController().signal;

    await judge.judge(req, signal);

    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0].request.rubricVersion).toBe("v7-doc");
    expect(judge.calls[0].request.category).toBe("documentation");
    expect(judge.calls[0].request).toBe(req);
    expect(judge.calls[0].signal).toBe(signal);
  });
});
