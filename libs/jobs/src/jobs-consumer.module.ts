import { Module } from "@nestjs/common";

// Placeholder for Phase 1. Real wiring lands in Phase 6:
//   @Processor('analysis') AnalysisProcessor
// consumed by apps/worker to process queued jobs. See design: "NestJS Wiring" - libs/jobs.
@Module({})
export class JobsConsumerModule {}
