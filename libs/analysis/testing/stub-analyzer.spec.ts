import { describe, expect, it } from "vitest";
import type { CategoryScore, RepoContext } from "../src/domain";
import { StubAnalyzer } from "./stub-analyzer";

function fakeRepoContext(): RepoContext {
  return {
    repoUrl: "https://github.com/acme/widget",
    commitSha: "a".repeat(40),
    rootPath: "/work",
    files: [],
    dominantLanguage: null,
    languageMix: [],
    totalLoc: 0,
    readFile: async () => "",
    glob: () => [],
  };
}

describe("StubAnalyzer", () => {
  it("succeeds mode: returns the canned CategoryScore verbatim", async () => {
    const canned: CategoryScore = {
      category: "security",
      status: "scored",
      score: 78,
      confidence: "measured",
      weightCap: 1,
      rationale: "no critical findings",
      findings: [],
      durationMs: 41,
    };
    const analyzer = new StubAnalyzer({ category: "security", result: canned });

    const outcome = await analyzer.analyze(fakeRepoContext(), new AbortController().signal);

    expect(outcome).toBe(canned);
    expect(outcome.score).toBe(78);
  });

  it("fails mode: throws the configured error instead of returning a score", async () => {
    const boom = new Error("LLM_TIMEOUT");
    const analyzer = new StubAnalyzer({ category: "architecture", error: boom });

    await expect(analyzer.analyze(fakeRepoContext(), new AbortController().signal)).rejects.toBe(boom);
  });

  it("records every call with the ctx and signal it was invoked with", async () => {
    const analyzer = new StubAnalyzer({
      category: "testing",
      result: {
        category: "testing",
        status: "scored",
        score: 41,
        confidence: "estimated",
        weightCap: 1,
        rationale: "low test file ratio",
        findings: [],
        durationMs: 12,
      },
    });
    const ctx = fakeRepoContext();
    const signal = new AbortController().signal;

    await analyzer.analyze(ctx, signal);

    expect(analyzer.calls).toHaveLength(1);
    expect(analyzer.calls[0].ctx).toBe(ctx);
    expect(analyzer.calls[0].signal).toBe(signal);
  });

  it("throws a helpful error if constructed with neither result nor error", async () => {
    const analyzer = new StubAnalyzer({ category: "documentation" });

    await expect(analyzer.analyze(fakeRepoContext(), new AbortController().signal)).rejects.toThrow(
      /configure either/,
    );
  });
});
