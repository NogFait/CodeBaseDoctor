import { describe, expect, it } from "vitest";
import { StubAnalyzer } from "../../testing/stub-analyzer";
import type { RepoContext } from "../domain";
import type { CategoryAnalyzer } from "../ports";
import { AnalyzerRunner, DEFAULT_TIMEOUT_MS_BY_CATEGORY } from "./analyzer-runner";

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

/**
 * Analyzer that ignores its AbortSignal entirely and never settles on its
 * own — the realistic worst case the runner's timeout race must handle
 * (e.g. a hung HTTP call with no abort wiring inside the adapter).
 */
function hangingAnalyzer(category: CategoryAnalyzer["category"]): CategoryAnalyzer {
  return {
    category,
    confidence: "measured",
    analyzerVersion: "hang-1.0.0",
    analyze: () => new Promise(() => {}),
  };
}

describe("AnalyzerRunner", () => {
  it("returns a scored CategoryScore for every analyzer when all succeed", async () => {
    const security = new StubAnalyzer({
      category: "security",
      result: {
        category: "security",
        status: "scored",
        score: 90,
        confidence: "measured",
        weightCap: 1,
        rationale: "clean",
        findings: [],
        durationMs: 5,
      },
    });
    const testing = new StubAnalyzer({
      category: "testing",
      result: {
        category: "testing",
        status: "scored",
        score: 40,
        confidence: "estimated",
        weightCap: 1,
        rationale: "low coverage",
        findings: [],
        durationMs: 5,
      },
    });
    const runner = new AnalyzerRunner();

    const results = await runner.run([security, testing], fakeRepoContext());

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      category: "security",
      status: "scored",
      score: 90,
      confidence: "measured",
      weightCap: 1,
      rationale: "clean",
      findings: [],
      durationMs: 5,
    });
    expect(results[1].category).toBe("testing");
    expect(results[1].status).toBe("scored");
  });

  it("never rejects/throws: a thrown analyzer becomes a status:'failed' CategoryScore, not a missing slot", async () => {
    const boom = new Error("architecture LLM blew up");
    const architecture = new StubAnalyzer({ category: "architecture", error: boom });
    const runner = new AnalyzerRunner();

    const results = await runner.run([architecture], fakeRepoContext());

    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result.category).toBe("architecture");
    expect(result.status).toBe("failed");
    expect(result.score).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain("architecture LLM blew up");
    expect(result.rationale.length).toBeGreaterThan(0);
    expect(typeof result.durationMs).toBe("number");
  });

  it("one analyzer failing does not affect the others — every slot is always present", async () => {
    const okScore = {
      category: "testing" as const,
      status: "scored" as const,
      score: 55,
      confidence: "estimated" as const,
      weightCap: 1,
      rationale: "ok",
      findings: [],
      durationMs: 5,
    };
    const testing = new StubAnalyzer({ category: "testing", result: okScore });
    const architecture = new StubAnalyzer({ category: "architecture", error: new Error("boom") });
    const runner = new AnalyzerRunner();

    const results = await runner.run([testing, architecture], fakeRepoContext());

    expect(results.map((r) => r.category)).toEqual(["testing", "architecture"]);
    expect(results[0].status).toBe("scored");
    expect(results[1].status).toBe("failed");
  });

  it("aborts a hanging analyzer's signal and yields status:'failed' once its per-category timeout elapses", async () => {
    const runner = new AnalyzerRunner({ timeoutMsByCategory: { performance: 15 } });
    const analyzer = hangingAnalyzer("performance");

    const results = await runner.run([analyzer], fakeRepoContext());

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("failed");
    expect(results[0].error?.code).toBe("ANALYZER_TIMEOUT");
  }, 2000);

  it("passes an AbortSignal to analyze() that fires when the analyzer's timeout elapses", async () => {
    const runner = new AnalyzerRunner({ timeoutMsByCategory: { documentation: 15 } });
    let observedAborted = false;
    const analyzer: CategoryAnalyzer = {
      category: "documentation",
      confidence: "judged",
      analyzerVersion: "probe-1.0.0",
      analyze: (_ctx, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            observedAborted = true;
          });
          // never resolves on its own — only the runner's timeout ends this.
          void resolve;
        }),
    };

    await runner.run([analyzer], fakeRepoContext());

    expect(observedAborted).toBe(true);
  }, 2000);

  it("gives each analyzer its own independent AbortSignal instance", async () => {
    const signals: AbortSignal[] = [];
    const probe = (category: CategoryAnalyzer["category"]): CategoryAnalyzer => ({
      category,
      confidence: "measured",
      analyzerVersion: "probe-1.0.0",
      analyze: async (_ctx, signal) => {
        signals.push(signal);
        return {
          category,
          status: "scored",
          score: 100,
          confidence: "measured",
          weightCap: 1,
          rationale: "ok",
          findings: [],
          durationMs: 1,
        };
      },
    });
    const runner = new AnalyzerRunner();

    await runner.run([probe("security"), probe("testing")], fakeRepoContext());

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  describe("DEFAULT_TIMEOUT_MS_BY_CATEGORY", () => {
    it("gives Security (Semgrep-backed) 180s, matching the design's container-scan budget", () => {
      expect(DEFAULT_TIMEOUT_MS_BY_CATEGORY.security).toBe(180_000);
    });

    it("gives every other (LLM/heuristic-backed) category 90s", () => {
      expect(DEFAULT_TIMEOUT_MS_BY_CATEGORY.testing).toBe(90_000);
      expect(DEFAULT_TIMEOUT_MS_BY_CATEGORY.maintainability).toBe(90_000);
      expect(DEFAULT_TIMEOUT_MS_BY_CATEGORY.architecture).toBe(90_000);
      expect(DEFAULT_TIMEOUT_MS_BY_CATEGORY.documentation).toBe(90_000);
      expect(DEFAULT_TIMEOUT_MS_BY_CATEGORY.performance).toBe(90_000);
    });
  });
});
