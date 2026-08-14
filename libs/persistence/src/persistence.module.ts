import { Module } from "@nestjs/common";

// Placeholder for Phase 1. Real providers land in Phase 3:
//   PrismaService
//   { provide: SCORE_REPOSITORY_PORT, useClass: PrismaScoreRepository }
//   { provide: USAGE_QUOTA_PORT, useClass: DailyFreeTierAdapter }
// See design: "NestJS Wiring" - libs/persistence.
@Module({})
export class PersistenceModule {}
