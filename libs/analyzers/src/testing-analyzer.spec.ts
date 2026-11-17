import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFixtureRepoContext } from "@cbd/repo-source/testing/fixture-repo-source";
import { TestingAnalyzer, scoreFromHeuristics } from "./testing-analyzer";

const FIXTURES_ROOT = path.resolve(__dirname, "../__fixtures__");

const asFiles = (...paths: string[]) => paths.map((p) => ({ path: p, sizeBytes: 10, loc: 1, language: null }));
const testCount = (...paths: string[]) => scoreFromHeuristics(asFiles(...paths)).testFileCount;

describe("test-file detection (regression: p-limit's test.js + index.test-d.ts scored as 0 tests)", () => {
  it.each([
    // JS/TS naming conventions
    "src/sum.test.ts", "src/sum.spec.tsx", "src/a.test.mjs", "src/a.spec.cjs", "index.test-d.ts",
    // bare test.js: ava / tap / node:test style at the root or in a package
    "test.js", "test.mjs", "packages/core/test.ts",
    // conventional test directories
    "test/index.js", "tests/unit/foo.py", "__tests__/a.tsx", "spec/models/user.rb", "tests/integration.rs",
    // other ecosystems
    "pkg/foo_test.go", "spec/user_spec.rb", "test/user_test.rb", "src/main/java/FooTest.java",
    "src/FooTests.cs", "src/FooTest.kt", "src/FooIT.java", "tests/FooTest.php",
    // already supported before
    "tests/test_sum.py", "pkg/sum_test.py",
  ])("counts %s as a test file", (file) => {
    expect(testCount(file)).toBe(1);
  });

  it.each([
    "src/contest.js", "src/latest.js", "src/attest.ts", "src/testing-utils.ts", "docs/testing.md",
    "test/fixtures/data.json", "tests/README.md", "tests/__init__.py", "src/protest/a.ts", "README.md",
    "src/test-helpers.ts", "src/Contest.java",
  ])("does NOT count %s as a test file", (file) => {
    expect(testCount(file)).toBe(0);
  });

  it("scores p-limit's real layout above the CI-only floor of 30", () => {
    const score = scoreFromHeuristics(
      asFiles(".github/workflows/main.yml", "index.js", "index.d.ts", "index.test-d.ts", "test.js", "readme.md", "package.json"),
    );

    expect(score.testFileCount).toBe(2);
    expect(score.hasCi).toBe(true);
    expect(score.score).toBeGreaterThan(30);
  });
});

/**
 * Scale: tests are measured against SOURCE files (not every file in the
 * repo), and the tests component saturates at 0.5 test files per source file.
 * Before, docs/config diluted the ratio so even commander.js (124 test files
 * of 220) topped out at 69.
 */
describe("test-ratio scale (normalized against source files, saturating at 0.5 tests per source file)", () => {
  const sources = (n: number) => Array.from({ length: n }, (_, i) => `src/mod${i}.ts`);
  const tests = (n: number) => Array.from({ length: n }, (_, i) => `src/mod${i}.test.ts`);
  const filler = (n: number) => Array.from({ length: n }, (_, i) => `docs/page${i}.md`);
  const score = (...paths: string[]) => scoreFromHeuristics(asFiles(...paths)).score;

  it("reaches the full 70-point tests component at 0.5 test files per source file (no CI)", () => {
    expect(score(...sources(4), ...tests(2))).toBe(70);
  });

  it("scales proportionally below the saturation point (1 test per 4 sources = half of it)", () => {
    expect(score(...sources(4), ...tests(1))).toBe(35);
  });

  it("never exceeds the cap: piling on tests does not push past 70 (100 with CI)", () => {
    expect(score(...sources(2), ...tests(10))).toBe(70);
    expect(score(...sources(2), ...tests(10), ".github/workflows/ci.yml")).toBe(100);
  });

  it("is NOT diluted by docs, config or other non-code files", () => {
    const lean = score(...sources(4), ...tests(2));
    const padded = score(...sources(4), ...tests(2), ...filler(60), "package.json", "tsconfig.json");

    expect(padded).toBe(lean);
  });

  it("does not count .d.ts type declarations as source files", () => {
    // sources: index.js only (index.d.ts excluded) -> 1 test per 1 source -> saturated
    expect(score("index.js", "index.d.ts", "test.js")).toBe(70);
  });

  it("saturates when there are tests but no source files at all", () => {
    expect(score(...tests(3))).toBe(70);
  });

  it("scores 0 when there are no tests, whatever else is there", () => {
    expect(score(...sources(5), ...filler(10))).toBe(0);
    expect(score(...filler(10))).toBe(0);
    expect(score()).toBe(0);
  });

  it("p-limit's real layout (2 tests, 1 source, CI) now scores at the top", () => {
    expect(
      score(".github/workflows/main.yml", "index.js", "index.d.ts", "index.test-d.ts", "test.js", "readme.md", "package.json"),
    ).toBe(100);
  });
});

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
    // 1 test file (sum.test.ts) per 1 source file (sum.ts) saturates the tests
    // component at 70; no CI config in this fixture -> non-zero, non-maximal.
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

  it("emits a structured rationale key + params (plural test files, no CI)", async () => {
    const ctx = await buildFixtureRepoContext(path.join(FIXTURES_ROOT, "no-tests-py"), {
      repoUrl: "https://github.com/fixture/no-tests-py",
      commitSha: "d".repeat(40),
    });
    const analyzer = new TestingAnalyzer();

    const result = await analyzer.analyze(ctx, new AbortController().signal);

    expect(result.rationaleKey).toBe("rationale.testing");
    expect(result.rationaleParams).toEqual({ n: 0, ci: false });
    // canonical English string stays byte-identical
    expect(result.rationale).toBe("0 test files detected by naming convention; no CI config found.");
  });

  it("emits a structured rationale key + params (singular test file, CI present)", async () => {
    const base = await buildFixtureRepoContext(path.join(FIXTURES_ROOT, "well-tested-ts"), {
      repoUrl: "https://github.com/fixture/well-tested-ts",
      commitSha: "e".repeat(40),
    });
    // well-tested-ts has exactly 1 test file; add a CI workflow to hit ci:true.
    const ctx = {
      ...base,
      files: [...base.files, { path: ".github/workflows/ci.yml", sizeBytes: 40, loc: 4, language: null }],
    };
    const analyzer = new TestingAnalyzer();

    const result = await analyzer.analyze(ctx, new AbortController().signal);

    expect(result.rationaleKey).toBe("rationale.testing");
    expect(result.rationaleParams).toEqual({ n: 1, ci: true });
    expect(result.rationale).toBe("1 test file detected by naming convention; CI config present.");
  });
});
