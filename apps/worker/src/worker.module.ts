import { Module } from "@nestjs/common";
import { AnalysisDomainModule } from "@cbd/analysis";
import { PersistenceModule } from "@cbd/persistence";
import { RepoSourceModule } from "@cbd/repo-source";
import { LlmModule } from "@cbd/llm";
import { AnalyzersModule } from "@cbd/analyzers";
import { JobsConsumerModule } from "@cbd/jobs";

// apps/worker holds every heavy adapter (Docker, Semgrep/OSV via
// libs/analyzers, the LLM judge) plus the same domain + persistence modules
// as apps/api. It physically cannot serve HTTP - no controllers, no
// @nestjs/platform-express dependency. See design: "NestJS Wiring".
@Module({
  imports: [
    AnalysisDomainModule,
    PersistenceModule,
    RepoSourceModule,
    LlmModule,
    AnalyzersModule,
    JobsConsumerModule,
  ],
})
export class WorkerModule {}
