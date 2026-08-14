import { Module } from "@nestjs/common";

// Placeholder for Phase 1. Real wiring lands in Phase 6:
//   BullModule.registerQueue({ name: 'analysis' })
// consumed by apps/api to enqueue jobs. See design: "NestJS Wiring" - libs/jobs.
@Module({})
export class JobsProducerModule {}
