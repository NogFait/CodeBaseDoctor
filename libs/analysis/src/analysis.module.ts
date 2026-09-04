import { Module } from "@nestjs/common";
import { RepoAnalysisService } from "./application";

// See design: "NestJS Wiring" - libs/analysis: "RepoAnalysisService,
// AnalyzerRunner, ScoreAggregator. Imports NOTHING infrastructural; declares
// port tokens." AnalyzerRunner/ScoreAggregator are plain composition inside
// RepoAnalysisService (not their own providers — they're pure domain
// helpers, not swappable ports), so only the service is registered here.
//
// Open wiring question for Phase 5/6 (not resolved here — no controller or
// processor exists yet to need it): RepoAnalysisService's constructor
// @Inject()s the four port tokens, but Nest resolves a provider's
// dependencies only from its OWN module's providers plus whatever THAT
// module imports — sibling modules imported into a common parent (e.g.
// ApiModule importing both AnalysisDomainModule and PersistenceModule) do
// NOT automatically share providers with each other. Whoever wires
// apps/api/api.module.ts / apps/worker/worker.module.ts will need either (a)
// AnalysisDomainModule to import PersistenceModule/RepoSourceModule/
// LlmModule/AnalyzersModule directly, trading away "imports nothing
// infrastructural", or (b) some re-export/dynamic-module scheme. Flagged,
// not guessed at, per apply-progress notes for this batch.
@Module({
  providers: [RepoAnalysisService],
  exports: [RepoAnalysisService],
})
export class AnalysisDomainModule {}
