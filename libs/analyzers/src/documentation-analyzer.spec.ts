import { describe, expect, it } from "vitest";
import type { CategoryId, JudgeVerdict, RepoContext } from "@cbd/analysis";
import { ScriptedJudge } from "@cbd/llm/testing/scripted-judge";
import { DocumentationAnalyzer } from "./documentation-analyzer";

function ctxWithReadme(readme: string | null): RepoContext {
  const files = readme !== null ? [{ path: "README.md", sizeBytes: readme.length, loc: 1, language: null }] : [];
  return {
    repoUrl: "https://github.com/x/y",
    commitSha: "0".repeat(40),
    rootPath: "/work",
    files,
    dominantLanguage: null,
    languageMix: [],
    totalLoc: 0,
    readFile: async (path: string) => {
      if (path === "README.md" && readme !== null) return readme;
      throw new Error(`unknown file "${path}"`);
    },
    glob: (pattern: string) => (pattern === "README.md" && readme !== null ? ["README.md"] : []),
  };
}

describe("DocumentationAnalyzer", () => {
  it("calls LLMJudgePort with category 'documentation', including the README heuristic pre-check in the prompt", async () => {
    const verdict: JudgeVerdict = {
      score: 74,
      rationale: "README covers setup and usage; missing an architecture overview.",
      modelId: "claude-test",
      promptTokens: 300,
      completionTokens: 90,
    };
    const script = new Map<CategoryId, JudgeVerdict | Error>([["documentation", verdict]]);
    const judge = new ScriptedJudge(script);
    const analyzer = new DocumentationAnalyzer(judge);

    const result = await analyzer.analyze(ctxWithReadme("# My Project\n\nSetup instructions here.\n"), new AbortController().signal);

    expect(judge.calls).toHaveLength(1);
    expect(judge.calls[0].request.category).toBe("documentation");
    expect(judge.calls[0].request.rubricId).toBeTruthy();
    expect(judge.calls[0].request.userPrompt).toContain("README present: yes");

    expect(result.confidence).toBe("judged");
    expect(result.weightCap).toBe(1);
    expect(result.score).toBe(74);
    expect(result.rationale).toBe(verdict.rationale);
  });

  it("flags a missing README in the prompt heuristic pre-check", async () => {
    const verdict: JudgeVerdict = { score: 10, rationale: "No README found.", modelId: "m", promptTokens: 1, completionTokens: 1 };
    const script = new Map<CategoryId, JudgeVerdict | Error>([["documentation", verdict]]);
    const judge = new ScriptedJudge(script);
    const analyzer = new DocumentationAnalyzer(judge);

    await analyzer.analyze(ctxWithReadme(null), new AbortController().signal);

    expect(judge.calls[0].request.userPrompt).toContain("README present: no");
  });
});
