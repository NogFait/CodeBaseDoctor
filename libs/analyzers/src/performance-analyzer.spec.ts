import { describe, expect, it } from "vitest";
import type { RepoContext, RepoFile } from "@cbd/analysis";
import { PerformanceAnalyzer } from "./performance-analyzer";

function ctxWithSources(sources: Record<string, string>): RepoContext {
  const files: RepoFile[] = Object.entries(sources).map(([p, content]) => ({
    path: p,
    sizeBytes: content.length,
    loc: content.split("\n").length,
    language: p.endsWith(".ts") || p.endsWith(".js") ? "TypeScript" : null,
  }));
  return {
    repoUrl: "https://github.com/x/y",
    commitSha: "0".repeat(40),
    rootPath: "/work",
    files,
    dominantLanguage: "TypeScript",
    languageMix: [],
    totalLoc: files.reduce((s, f) => s + f.loc, 0),
    readFile: async (path: string) => {
      const content = sources[path];
      if (content === undefined) throw new Error(`unknown file "${path}"`);
      return content;
    },
    glob: () => [],
  };
}

describe("PerformanceAnalyzer", () => {
  it("always reports weightCap 0.5 and confidence 'estimated' — the spec's hard requirement", async () => {
    const ctx = ctxWithSources({ "src/index.ts": "export const x = 1;\n" });
    const analyzer = new PerformanceAnalyzer();

    const result = await analyzer.analyze(ctx, new AbortController().signal);

    expect(result.weightCap).toBe(0.5);
    expect(result.confidence).toBe("estimated");
    expect(result.category).toBe("performance");
  });

  it("flags synchronous fs calls as findings and reduces the score", async () => {
    const clean = ctxWithSources({ "src/a.ts": "export const x = 1;\n" });
    const withSyncCalls = ctxWithSources({
      "src/a.ts": "const data = fs.readFileSync('x');\nconst out = fs.writeFileSync('y', data);\n",
    });
    const analyzer = new PerformanceAnalyzer();

    const cleanResult = await analyzer.analyze(clean, new AbortController().signal);
    const flaggedResult = await analyzer.analyze(withSyncCalls, new AbortController().signal);

    expect(flaggedResult.findings.length).toBeGreaterThan(0);
    expect(flaggedResult.findings.some((f) => f.ruleId === "sync-fs-call")).toBe(true);
    expect(flaggedResult.score).toBeLessThan(cleanResult.score ?? 101);
    expect(flaggedResult.rationale).toContain("Static heuristic");
  });

  it("flags a naive nested loop pattern", async () => {
    const withNestedLoop = ctxWithSources({
      "src/b.ts": "for (const a of items) {\n  for (const b of items) {\n    check(a, b);\n  }\n}\n",
    });
    const analyzer = new PerformanceAnalyzer();

    const result = await analyzer.analyze(withNestedLoop, new AbortController().signal);

    expect(result.findings.some((f) => f.ruleId === "nested-loop")).toBe(true);
  });
});
