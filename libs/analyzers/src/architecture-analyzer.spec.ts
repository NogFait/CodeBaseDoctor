import { describe, expect, it } from "vitest";
import type { CategoryId, JudgeVerdict, RepoContext } from "@cbd/analysis";
import { ScriptedJudge } from "@cbd/llm/testing/scripted-judge";
import { ArchitectureAnalyzer } from "./architecture-analyzer";

function fakeCtx(): RepoContext {
  return {
    repoUrl: "https://github.com/x/y",
    commitSha: "0".repeat(40),
    rootPath: "/work",
    files: [
      { path: "src/index.ts", sizeBytes: 100, loc: 10, language: "TypeScript" },
      { path: "src/util.ts", sizeBytes: 50, loc: 5, language: "TypeScript" },
    ],
    dominantLanguage: "TypeScript",
    languageMix: [{ language: "TypeScript", loc: 15, share: 1 }],
    totalLoc: 15,
    readFile: async () => "",
    glob: () => [],
  };
}

describe("ArchitectureAnalyzer", () => {
  it("calls LLMJudgePort with category 'architecture' and a real rubric, returning the verdict untouched", async () => {
    const verdict: JudgeVerdict = {
      score: 82,
      rationale: "Clean hexagonal boundaries; ports isolate infra concerns well.",
      modelId: "claude-test",
      promptTokens: 500,
      completionTokens: 120,
    };
    const script = new Map<CategoryId, JudgeVerdict | Error>([["architecture", verdict]]);
    const judge = new ScriptedJudge(script);
    const analyzer = new ArchitectureAnalyzer(judge);

    const result = await analyzer.analyze(fakeCtx(), new AbortController().signal);

    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0].request.category).toBe("architecture");
    expect(judge.calls[0].request.rubricId).toBeTruthy();
    expect(judge.calls[0].request.rubricVersion).toBeTruthy();
    expect(judge.calls[0].request.userPrompt).toContain("TypeScript");

    expect(result.category).toBe("architecture");
    expect(result.confidence).toBe("judged");
    expect(result.weightCap).toBe(1);
    expect(result.status).toBe("scored");
    expect(result.score).toBe(82);
    expect(result.rationale).toBe(verdict.rationale);
  });

  it("propagates a judge failure rather than swallowing it (AnalyzerRunner maps it to status:'failed' upstream)", async () => {
    const script = new Map<CategoryId, JudgeVerdict | Error>([
      ["architecture", new Error("LLM_TIMEOUT")],
    ]);
    const judge = new ScriptedJudge(script);
    const analyzer = new ArchitectureAnalyzer(judge);

    await expect(analyzer.analyze(fakeCtx(), new AbortController().signal)).rejects.toThrow("LLM_TIMEOUT");
  });
});
