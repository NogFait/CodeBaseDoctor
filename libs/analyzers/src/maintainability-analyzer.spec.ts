import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { RepoContext, RepoFile } from "@cbd/analysis";
import { buildFixtureRepoContext } from "@cbd/repo-source/testing/fixture-repo-source";
import { MaintainabilityAnalyzer } from "./maintainability-analyzer";

const FIXTURES_ROOT = path.resolve(__dirname, "../__fixtures__");

function ctxWithFiles(files: RepoFile[]): RepoContext {
  return {
    repoUrl: "https://github.com/x/y",
    commitSha: "0".repeat(40),
    rootPath: "/work",
    files,
    dominantLanguage: null,
    languageMix: [],
    totalLoc: files.reduce((s, f) => s + f.loc, 0),
    readFile: async () => "",
    glob: () => [],
  };
}

describe("MaintainabilityAnalyzer", () => {
  it("scores the well-tested-ts fixture near-perfect — every file is small", async () => {
    const ctx = await buildFixtureRepoContext(path.join(FIXTURES_ROOT, "well-tested-ts"), {
      repoUrl: "https://github.com/fixture/well-tested-ts",
      commitSha: "a".repeat(40),
    });
    const analyzer = new MaintainabilityAnalyzer();

    const result = await analyzer.analyze(ctx, new AbortController().signal);

    expect(result.category).toBe("maintainability");
    expect(result.confidence).toBe("measured");
    expect(result.weightCap).toBe(1);
    expect(result.status).toBe("scored");
    expect(result.score).toBe(100);
    expect(result.rationale).toContain("0 oversized file");
  });

  it("penalizes a repo where most files are oversized (>300 LOC)", async () => {
    // Synthetic — triangulates the large-file-penalty branch the tiny
    // fixtures never exercise (their real files are a handful of lines).
    const ctx = ctxWithFiles([
      { path: "a.ts", sizeBytes: 20_000, loc: 500, language: "TypeScript" },
      { path: "b.ts", sizeBytes: 20_000, loc: 600, language: "TypeScript" },
      { path: "c.ts", sizeBytes: 200, loc: 10, language: "TypeScript" },
    ]);
    const analyzer = new MaintainabilityAnalyzer();

    const result = await analyzer.analyze(ctx, new AbortController().signal);

    // 2 of 3 recognized files are oversized -> a real, non-maximal score
    expect(result.score).toBeLessThan(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.rationale).toContain("2 oversized file");
  });

  it("a repo with zero recognized-language files scores a defined, non-crashing result", async () => {
    const ctx = ctxWithFiles([{ path: "README.md", sizeBytes: 100, loc: 5, language: null }]);
    const analyzer = new MaintainabilityAnalyzer();

    const result = await analyzer.analyze(ctx, new AbortController().signal);

    expect(result.status).toBe("scored");
    expect(Number.isFinite(result.score)).toBe(true);
  });
});
