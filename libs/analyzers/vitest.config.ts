import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@cbd/analyzers",
    environment: "node",
    include: ["src/**/*.{spec,test}.ts"],
    // security-analyzer.integration.spec.ts spins up real Docker containers
    // (fetcher + scanner, including a real Semgrep/OSV-Scanner invocation)
    // and a local git daemon. 60s (this file's original value, matching
    // @cbd/repo-source's own integration-spec timeout at the time) turned
    // out NOT generous enough once the scanner actually ran Semgrep +
    // OSV-Scanner for real (task 3.2.8): verified directly, a single cold
    // `docker run` of cbd-scanner:local against a tiny two-file fixture
    // alone took ~56s (osv-scanner copying + loading the baked
    // ~240MB npm+PyPI offline vulnerability DB off the image dominates
    // that), before even adding the fetcher clone/du/ls-tree-count steps
    // materialize() also runs — the "dirty-repo" test timed out at exactly
    // 60008ms as a result. Bumped with real margin above the measured
    // worst case, not just nudged past the failure.
    testTimeout: 180_000,
    hookTimeout: 30_000,
  },
});
