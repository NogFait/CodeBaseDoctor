import { Module } from "@nestjs/common";
import { SCORE_REPOSITORY_PORT, USAGE_QUOTA_PORT } from "@cbd/analysis";
import { PrismaService } from "./prisma.service";
import { PrismaScoreRepository } from "./prisma-score-repository";
import { DailyFreeTierAdapter } from "./daily-free-tier-adapter";

// See design: "NestJS Wiring" - libs/persistence.
// useFactory (not useClass), same reasoning documented for RepoSourceModule
// / AnalyzersModule / LlmModule: PrismaScoreRepository and
// DailyFreeTierAdapter take a plain `PrismaClient` constructor param
// (PrismaService IS-A PrismaClient), which Nest's reflection-based
// constructor injection resolves fine when injected explicitly via
// useFactory, but there is no reason to rely on ambient reflection here when
// an explicit factory is just as simple and consistent with the rest of the
// codebase's adapter wiring.
@Module({
  providers: [
    PrismaService,
    {
      provide: SCORE_REPOSITORY_PORT,
      useFactory: (prisma: PrismaService) => new PrismaScoreRepository(prisma),
      inject: [PrismaService],
    },
    {
      provide: USAGE_QUOTA_PORT,
      useFactory: (prisma: PrismaService) => new DailyFreeTierAdapter(prisma),
      inject: [PrismaService],
    },
  ],
  exports: [PrismaService, SCORE_REPOSITORY_PORT, USAGE_QUOTA_PORT],
})
export class PersistenceModule {}
