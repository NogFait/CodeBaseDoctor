import type { CategoryId } from "./types";

/**
 * A pure, static mirror of every `CategoryAnalyzer` class's current
 * `analyzerVersion` field. ZERO NestJS/LLM/Docker dependencies — lives here
 * (this package's pure-data domain layer, not `libs/analyzers`) specifically
 * so that `apps/api` can import it as part of its already-legitimate
 * `@cbd/analysis` dependency, WITHOUT ever depending on `@cbd/analyzers`
 * (which pulls in `AnalyzersModule`, `@nestjs/common`, and analyzer classes
 * that require an `LLMJudgePort`). See `engine-version.ts` in this same
 * directory for why both `RepoAnalysisService` (worker, live analyzer
 * instances) and apps/api's job-submission use case (this static manifest)
 * must compute an identical `engineVersion`.
 *
 * DRIFT RISK: this is a manually-duplicated mirror of each analyzer's
 * `analyzerVersion` field — it WILL drift if someone bumps an analyzer's
 * version without updating this manifest. The safeguard lives in
 * `libs/analyzers/src/analyzer-versions.spec.ts` (not here): that package is
 * the one place already allowed to depend on all 6 real analyzer classes,
 * so its test instantiates them and asserts they match this object exactly.
 */
export const ANALYZER_VERSIONS: Record<CategoryId, string> = {
  security: "security-1.0.0",
  testing: "testing-1.0.0",
  maintainability: "maintainability-1.0.0",
  architecture: "architecture-1.0.0",
  documentation: "documentation-1.0.1",
  performance: "performance-1.0.0",
};
