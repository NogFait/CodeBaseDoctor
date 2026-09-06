import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AnalysisDomainModule } from "@cbd/analysis";
import { AnalysisProcessor } from "./analysis-processor";
import { ANALYSIS_QUEUE_NAME } from "./analysis-queue-producer";

// Real wiring for Phase 6's BullMQ consumer side (task 6.2). See design:
// "NestJS Wiring" - libs/jobs: "JobsConsumerModule - @Processor('analysis')
// AnalysisProcessor".
//
// `BullModule.forRoot()` mirrors JobsProducerModule's own connection config
// verbatim (same env vars, same localhost default) — duplicated rather than
// factored into a shared module, per jobs-producer.module.ts's own doc
// comment anticipating exactly this ("a future consumer batch ...  will
// need its own Redis connection config too, since apps/api and apps/worker
// are separate processes"). apps/api never imports JobsConsumerModule and
// apps/worker never imports JobsProducerModule (see worker.module.ts /
// api.module.ts), so there is no risk of double-registering
// `BullModule.forRoot()` within one process.
//
// `AnalysisDomainModule` is imported here directly (not relied on via
// `@Global()`, unlike PersistenceModule/RepoSourceModule/LlmModule/
// AnalyzersModule): `AnalysisDomainModule` itself is deliberately NOT
// `@Global()` (see its own doc comment — it imports nothing infrastructural
// and is only visible to modules that explicitly import it). Importing it
// here does not create a circular PACKAGE dependency: `@cbd/analysis` still
// imports nothing from `@cbd/jobs`. `USAGE_QUOTA_PORT` (also needed by
// AnalysisProcessor) does NOT need an explicit import here — it comes from
// `PersistenceModule`, which IS `@Global()` and is already loaded elsewhere
// in apps/worker's module graph (see worker.module.ts), so it's visible
// here with zero new import edges, same reasoning as analysis.module.ts's
// own doc comment.
@Module({
  imports: [
    AnalysisDomainModule,
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? "localhost",
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    BullModule.registerQueue({ name: ANALYSIS_QUEUE_NAME }),
  ],
  providers: [AnalysisProcessor],
})
export class JobsConsumerModule {}
