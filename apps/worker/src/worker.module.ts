import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AnalysisDomainModule } from "@cbd/analysis";
import { PersistenceModule } from "@cbd/persistence";
import { RepoSourceModule } from "@cbd/repo-source";
import { LlmModule } from "@cbd/llm";
import { AnalyzersModule } from "@cbd/analyzers";
import { JobsConsumerModule } from "@cbd/jobs";
import { StaleJobWatchdogService } from "./stale-job-watchdog.service";
import { StaleJobWatchdogScheduler } from "./stale-job-watchdog.scheduler";

// apps/worker holds every heavy adapter (Docker, Semgrep/OSV via
// libs/analyzers, the LLM judge) plus the same domain + persistence modules
// as apps/api. It physically cannot serve HTTP - no controllers, no
// @nestjs/platform-express dependency. See design: "NestJS Wiring".
//
// `ScheduleModule.forRoot()` (task 6.3, stale-job watchdog): registered
// here, once — checked first that nothing else in this graph already
// imports `@nestjs/schedule` (confirmed via `rg "@nestjs/schedule"` before
// this batch: zero hits anywhere in the repo). `StaleJobWatchdogService` /
// `StaleJobWatchdogScheduler` are apps/worker-only providers (not a shared
// lib) — see their own doc comments.
@Module({
  imports: [
    AnalysisDomainModule,
    PersistenceModule,
    RepoSourceModule,
    LlmModule,
    AnalyzersModule,
    JobsConsumerModule,
    ScheduleModule.forRoot(),
  ],
  providers: [StaleJobWatchdogService, StaleJobWatchdogScheduler],
})
export class WorkerModule {}
