import { Module } from "@nestjs/common";
import { PersistenceModule } from "@cbd/persistence";
import { JobsProducerModule } from "@cbd/jobs";
import { RepoSourceModule } from "@cbd/repo-source";
import { AnalysesController } from "./analyses/analyses.controller";
import { SubmitAnalysisUseCase } from "./analyses/submit-analysis.use-case";

// apps/api imports RepoSourceModule directly for REPO_SOURCE_PORT
// (resolve()/head() only — cheap: no clone, no Docker scan container, no
// analyzer, no LLM call. materialize(), the actual clone+scan, is only ever
// invoked from RepoAnalysisService.analyze(), which only the worker's
// AnalysisProcessor (Phase 6) calls).
//
// apps/api does NOT import AnalyzersModule, LlmModule, or
// AnalysisDomainModule (RepoAnalysisService) for anything — it is
// physically incapable of running an analyzer or calling the LLM judge,
// only the worker can. This is the invariant this whole batch protects; see
// SubmitAnalysisUseCase, which builds its own lightweight resolve->head->
// cache-check->quota.consume->create-job-row->enqueue->202 flow directly
// from ports, and never calls RepoAnalysisService. (Earlier revision of
// this module imported AnalysisDomainModule, which is unusable here anyway:
// AnalysisDomainModule provides RepoAnalysisService, whose constructor
// needs CATEGORY_ANALYZERS/LLM_JUDGE_PORT — tokens apps/api's graph never
// provides by design — so importing it would have thrown
// UnknownDependenciesException the moment a real Nest app tried to boot
// this module. See engram sdd/codebase-doctor-mvp/apply-progress, batch
// 2026-09-04, Learned #2 for the trace.)
// See design: "NestJS Wiring".
@Module({
  imports: [RepoSourceModule, PersistenceModule, JobsProducerModule],
  controllers: [AnalysesController],
  providers: [SubmitAnalysisUseCase],
})
export class ApiModule {}
