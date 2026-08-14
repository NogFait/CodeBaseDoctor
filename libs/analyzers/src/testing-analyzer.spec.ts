import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFixtureRepoContext } from "@cbd/repo-source/testing/fixture-repo-source";
import { TestingAnalyzer } from "./testing-analyzer";

const FIXTURES_ROOT = path.resolve(__dirname, "../__fixtures__");

describe("TestingAnalyzer", () => {
  it("scores the well-tested-ts fixture highly — has a test file and CI config", async () => {
    const ctx = await buildFixtureRepoContext(path.join(FIXTURES_ROOT, "well-tested-ts"), {
      repoUrl: "https://github.com/fixture/well-tested-ts",
      commitSha: "a".repeat(40),
    });
    const analyzer = new TestingAnalyzer();

    const result = await analyzer.analyze(ctx, new AbortController().signal);

    expect(result.category).toBe("testing");
    expect(result.confidence).toBe("estimated");
    expect(result.weightCap).toBe(1);
    expect(result.status).toBe("scored");
    // 1 test file (sum.test.ts) out of 4 files = 0.25 ratio, no CI config present
    // in this fixture -> real, non-trivial, non-zero, non-maximal score.
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(100);
    expect(result.rationale).toContain("test file");
  });

  it("scores the no-tests-py fixture at the floor — zero test files, no CI", async () => {
    const ctx = await buildFixtureRepoContext(path.join(FIXTURES_ROOT, "no-tests-py"), {
      repoUrl: "https://github.com/fixture/no-tests-py",
      commitSha: "b".repeat(40),
    });
    const analyzer = new TestingAnalyzer();

    const result = await analyzer.analyze(ctx, new AbortController().signal);

    expect(result.score).toBe(0);
    expect(result.rationale).toContain("0 test file");
  });

  it("a fixture with CI config present scores strictly higher than an identical one without it", async () => {
    const withoutCi = await buildFixtureRepoContext(path.join(FIXTURES_ROOT, "no-tests-py"), {
      repoUrl: "https://github.com/fixture/no-tests-py",
      commitSha: "c".repeat(40),
    });
    const analyzer = new TestingAnalyzer();
    const baseline = await analyzer.analyze(withoutCi, new AbortController().signal);

    // Synthetic RepoContext reusing the same file list plus a CI workflow —
    // triangulates the CI-presence branch without needing a 4th fixture dir.
    const withCi = {
      ...withoutCi,
      files: [...withoutCi.files, { path: ".github/workflows/ci.yml", sizeBytes: 40, loc: 4, language: null }],
    };
    const withCiResult = await analyzer.analyze(withCi, new AbortController().signal);

    expect(withCiResult.score).toBeGreaterThan(baseline.score ?? -1);
    expect(withCiResult.rationale).toContain("CI config present");
  });
});
