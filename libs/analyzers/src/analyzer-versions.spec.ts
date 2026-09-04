import { describe, expect, it } from "vitest";
import { ANALYZER_VERSIONS, computeEngineVersion, type CategoryId, type LLMJudgePort } from "@cbd/analysis";
import { SecurityAnalyzer } from "./security-analyzer";
import { TestingAnalyzer } from "./testing-analyzer";
import { MaintainabilityAnalyzer } from "./maintainability-analyzer";
import { ArchitectureAnalyzer } from "./architecture-analyzer";
import { DocumentationAnalyzer } from "./documentation-analyzer";
import { PerformanceAnalyzer } from "./performance-analyzer";

// Documentation/Architecture analyzers only need an LLMJudgePort to satisfy
// their constructor — .analyzerVersion is a readonly field, never derived
// from the judge, so a never-called stub is enough here.
const unusedJudge = {} as LLMJudgePort;

function realAnalyzerVersions(): Record<CategoryId, string> {
  return {
    security: new SecurityAnalyzer().analyzerVersion,
    testing: new TestingAnalyzer().analyzerVersion,
    maintainability: new MaintainabilityAnalyzer().analyzerVersion,
    architecture: new ArchitectureAnalyzer(unusedJudge).analyzerVersion,
    documentation: new DocumentationAnalyzer(unusedJudge).analyzerVersion,
    performance: new PerformanceAnalyzer().analyzerVersion,
  };
}

describe("ANALYZER_VERSIONS drift guard", () => {
  it("mirrors every real analyzer class's current analyzerVersion field exactly", () => {
    // A REAL assertion, not a tautology: this instantiates the 6 real
    // analyzer classes (production code) and compares against the
    // hand-maintained manifest. If someone bumps an analyzer's
    // `analyzerVersion` without updating ANALYZER_VERSIONS, this goes RED —
    // see apply-progress for the deliberate manual mismatch used to prove
    // that (temporarily edited, observed RED, reverted).
    expect(ANALYZER_VERSIONS).toEqual(realAnalyzerVersions());
  });

  it("produces the SAME engineVersion whether computed from live analyzer instances (worker/RepoAnalysisService shape) or from the static manifest (apps/api shape)", () => {
    const real = realAnalyzerVersions();
    const fromLiveInstances = computeEngineVersion(
      (Object.entries(real) as [CategoryId, string][]).map(([category, analyzerVersion]) => ({
        category,
        analyzerVersion,
      })),
    );
    const fromStaticManifest = computeEngineVersion(
      (Object.entries(ANALYZER_VERSIONS) as [CategoryId, string][]).map(([category, analyzerVersion]) => ({
        category,
        analyzerVersion,
      })),
    );

    expect(fromLiveInstances).toBe(fromStaticManifest);
  });
});
