import type { CategoryAnalyzer, CategoryScore, RepoContext, RepoFile } from "@cbd/analysis";

const TEST_FILE_PATTERNS = [/\.spec\.[jt]sx?$/, /\.test\.[jt]sx?$/, /(^|\/)test_[^/]+\.py$/, /_test\.py$/];
const CI_CONFIG_PATTERNS = [
  /^\.github\/workflows\/.+\.ya?ml$/,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.circleci\/config\.ya?ml$/,
];

function isTestFile(file: RepoFile): boolean {
  return TEST_FILE_PATTERNS.some((re) => re.test(file.path));
}

function hasCiConfig(files: readonly RepoFile[]): boolean {
  return files.some((f) => CI_CONFIG_PATTERNS.some((re) => re.test(f.path)));
}

/** Pure — test-file ratio weighted 70, CI-config presence weighted 30,
 * matching the spec's confidence table ("Heuristics (file ratio, naming, CI
 * presence)"). Real heuristics, not a stub: driven entirely by
 * RepoContext.files, which is real data for both fixtures and production. */
export function scoreFromHeuristics(files: readonly RepoFile[]): { score: number; testFileCount: number; testRatio: number; hasCi: boolean } {
  const testFileCount = files.filter(isTestFile).length;
  const testRatio = files.length === 0 ? 0 : testFileCount / files.length;
  const hasCi = hasCiConfig(files);
  const score = Math.round(testRatio * 70 + (hasCi ? 30 : 0));
  return { score: Math.max(0, Math.min(100, score)), testFileCount, testRatio, hasCi };
}

/**
 * confidence: estimated — real heuristics over RepoContext.files (test-file
 * naming convention ratio, CI config presence). No LLM, no external tool.
 * See spec: category-scoring.
 */
export class TestingAnalyzer implements CategoryAnalyzer {
  readonly category = "testing" as const;
  readonly confidence = "estimated" as const;
  readonly analyzerVersion = "testing-1.0.0";

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
      findings: [],
      durationMs: Date.now() - startedAt,
    };
  }
}
