import { Module } from "@nestjs/common";
import { AnalysisDomainModule } from "@cbd/analysis";
import { PersistenceModule } from "@cbd/persistence";
import { JobsProducerModule } from "@cbd/jobs";

// apps/api never imports libs/analyzers, libs/llm or libs/repo-source: it can
// enqueue work but it physically cannot run an analyzer (never provided).
// See design: "NestJS Wiring".
//
// `controllers` is empty in Phase 1 - AnalysesController is scaffolded in
// Phase 5 (see tasks.md 5.1/5.2). Wiring it here now would reference a class
// that doesn't exist yet.
@Module({
  imports: [AnalysisDomainModule, PersistenceModule, JobsProducerModule],
  controllers: [],
})
export class ApiModule {}
