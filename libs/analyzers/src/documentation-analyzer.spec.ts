import { describe, expect, it } from "vitest";
import type { CategoryId, JudgeVerdict, RepoContext } from "@cbd/analysis";
import { ScriptedJudge } from "@cbd/llm/testing/scripted-judge";
import { DocumentationAnalyzer } from "./documentation-analyzer";

/**
 * `fileContents` maps repo-relative path -> content. `glob` is exact-match
 * only (like the real one over `files`), so the analyzer cannot rely on it
 * for case-insensitive lookups.
 */
function ctxWithFiles(fileContents: Record<string, string>): RepoContext {
  const files = Object.entries(fileContents).map(([path, content]) => ({
    path,
    sizeBytes: content.length,
    loc: 1,
    language: null,
  }));
  return {
    repoUrl: "https://github.com/x/y",
    commitSha: "0".repeat(40),
    rootPath: "/work",
    files,
    dominantLanguage: null,
    languageMix: [],
    totalLoc: 0,
    readFile: async (path: string) => {
      if (path in fileContents) return fileContents[path];
      throw new Error(`unknown file "${path}"`);
    },
    glob: (pattern: string) => (pattern in fileContents ? [pattern] : []),
  };
}

function ctxWithReadme(readme: string | null): RepoContext {
  return ctxWithFiles(readme !== null ? { "README.md": readme } : {});
}

const OK_VERDICT: JudgeVerdict = { score: 50, rationale: "ok", modelId: "m", promptTokens: 1, completionTokens: 1 };

async function promptFor(ctx: RepoContext): Promise<string> {
  const judge = new ScriptedJudge(new Map<CategoryId, JudgeVerdict | Error>([["documentation", OK_VERDICT]]));
  await new DocumentationAnalyzer(judge).analyze(ctx, new AbortController().signal);
  return judge.calls[0].request.userPrompt;
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

  describe("README detection is case-insensitive and extension-tolerant (regression: p-limit's readme.md scored 15 as 'no README')", () => {
    it.each(["readme.md", "Readme.md", "README.markdown", "readme.rst", "README.adoc", "readme"])(
      "finds %s at the repo root and feeds its content to the judge",
      async (name) => {
        const prompt = await promptFor(ctxWithFiles({ [name]: "# Title\n\nSetup instructions.\n" }));

        expect(prompt).toContain("README present: yes");
        expect(prompt).toContain(`README path: ${name}`);
        expect(prompt).toContain("Setup instructions.");
      },
    );

    it("prefers README.md over other README flavours when several exist", async () => {
      const prompt = await promptFor(ctxWithFiles({ "README.txt": "plain", "README.md": "# markdown one" }));

      expect(prompt).toContain("README path: README.md");
      expect(prompt).toContain("# markdown one");
    });

    it("does NOT count a nested docs/README.md as the project README", async () => {
      const prompt = await promptFor(ctxWithFiles({ "docs/README.md": "# only docs" }));

      expect(prompt).toContain("README present: no");
    });

    it("does not mistake README-lookalikes (README.md.bak, readme-old.md) for a README", async () => {
      const prompt = await promptFor(ctxWithFiles({ "README.md.bak": "x", "readme-old.md": "y" }));

      expect(prompt).toContain("README present: no");
    });
  });
});
