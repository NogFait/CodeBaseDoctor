import type { CategoryAnalyzer, CategoryScore, RepoContext, RepoFile } from "@cbd/analysis";

// Source extensions a test can live in. Keeps `test/fixtures/data.json` and
// `tests/README.md` from counting just for sitting under a test directory.
const CODE_EXT = "(?:[cm]?[jt]sx?|py|go|rb|rs|java|kt|cs|php)";

// Name-based conventions. Detection is heuristic (confidence: estimated), but
// it must at least know the common ecosystems — exact `.test.ts` / `.spec.ts`
// matching alone scored p-limit (test.js + index.test-d.ts) as "0 tests".
const TEST_FILE_PATTERNS = [
  new RegExp(`\\.(?:spec|test)(?:-d)?\\.${CODE_EXT}$`), // foo.test.ts, foo.spec.mjs, foo.test-d.ts (tsd)
  /(^|\/)test\.[cm]?[jt]sx?$/, // bare test.js (ava, tap, node:test) at the root or in a package
  /(^|\/)test_[^/]+\.py$/,
  /_test\.py$/,
  /_test\.go$/,
  /_(?:spec|test)\.rb$/,
  /(?:Test|Tests|IT)\.(?:java|kt|cs)$/,
  /Test\.php$/,
];
// Anything with a source extension under a conventional test directory.
const TEST_DIR_PATTERN = new RegExp(`(^|/)(?:tests?|__tests__|specs?)/.+\\.${CODE_EXT}$`);
// Package markers / shared setup inside test dirs are not tests themselves.
const NOT_A_TEST_BASENAMES = new Set(["__init__.py"]);
const CI_CONFIG_PATTERNS = [
  /^\.github\/workflows\/.+\.ya?ml$/,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.circleci\/config\.ya?ml$/,
];

function isTestFile(file: RepoFile): boolean {
  const basename = file.path.slice(file.path.lastIndexOf("/") + 1);
  if (NOT_A_TEST_BASENAMES.has(basename)) return false;
  return TEST_FILE_PATTERNS.some((re) => re.test(file.path)) || TEST_DIR_PATTERN.test(file.path);
}

function hasCiConfig(files: readonly RepoFile[]): boolean {
  return files.some((f) => CI_CONFIG_PATTERNS.some((re) => re.test(f.path)));
}

// A "source file" is real logic: code that is not a test and not a `.d.ts`
// type declaration. Docs, configs and data are excluded so they can't dilute
// the ratio (commander.js, 124 test files of 220, used to top out at 69).
const SOURCE_FILE_PATTERN = new RegExp(`\\.${CODE_EXT}$`);
const TYPE_DECLARATION_PATTERN = /\.d\.[cm]?ts$/;

/** Tests per source file at which the tests component is already maxed out. */
const SATURATION_RATIO = 0.5;
const TESTS_WEIGHT = 70;
const CI_WEIGHT = 30;

function isSourceFile(file: RepoFile): boolean {
  return SOURCE_FILE_PATTERN.test(file.path) && !TYPE_DECLARATION_PATTERN.test(file.path) && !isTestFile(file);
}

/** Pure — the tests component (weight 70) is test files per SOURCE file,
 * saturating at `SATURATION_RATIO`; CI-config presence adds 30. Matches the
 * spec's confidence table ("Heuristics (file ratio, naming, CI presence)").
 * Real heuristics, not a stub: driven entirely by RepoContext.files, which
 * is real data for both fixtures and production.
 *
 * `testRatio` is test files per source file; with tests but no source files
 * at all it is 1 (nothing to be under-tested against), and 0 with no tests. */
export function scoreFromHeuristics(files: readonly RepoFile[]): {
  score: number;
  testFileCount: number;
  sourceFileCount: number;
  testRatio: number;
  hasCi: boolean;
} {
  const testFileCount = files.filter(isTestFile).length;
  const sourceFileCount = files.filter(isSourceFile).length;
  const testRatio = testFileCount === 0 ? 0 : sourceFileCount === 0 ? 1 : testFileCount / sourceFileCount;
  const hasCi = hasCiConfig(files);
  const testsComponent = Math.min(testRatio / SATURATION_RATIO, 1) * TESTS_WEIGHT;
  const score = Math.round(testsComponent + (hasCi ? CI_WEIGHT : 0));
  return { score: Math.max(0, Math.min(100, score)), testFileCount, sourceFileCount, testRatio, hasCi };
}

/**
 * confidence: estimated — real heuristics over RepoContext.files (test-file
 * naming convention ratio, CI config presence). No LLM, no external tool.
 * See spec: category-scoring.
 */
export class TestingAnalyzer implements CategoryAnalyzer {
  readonly category = "testing" as const;
  readonly confidence = "estimated" as const;
  // 1.1.0: (a) test-file detection covers test.js, *.test-d.ts, test dirs and
  // Go/Ruby/Java/Kotlin/C#/PHP; (b) the ratio is measured against source files
  // and saturates at 0.5 tests per source file. Both change scores, so bumping
  // invalidates every cached testing score.
  readonly analyzerVersion = "testing-1.1.0";

  async analyze(ctx: RepoContext, _signal: AbortSignal): Promise<CategoryScore> {
    const startedAt = Date.now();
    const { score, testFileCount, hasCi } = scoreFromHeuristics(ctx.files);

    return {
      category: this.category,
      status: "scored",
      score,
      confidence: this.confidence,
      weightCap: 1,
      rationale: `${testFileCount} test file${testFileCount === 1 ? "" : "s"} detected by naming convention; ${
        hasCi ? "CI config present" : "no CI config found"
      }.`,
      rationaleKey: "rationale.testing",
      rationaleParams: { n: testFileCount, ci: hasCi },
      findings: [],
      durationMs: Date.now() - startedAt,
    };
  }
}
