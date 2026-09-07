import { Global, Module } from "@nestjs/common";
import { Redis } from "ioredis";
import { HEAD_CALL_RATE_LIMITER_PORT, SCORE_REPOSITORY_PORT, USAGE_QUOTA_PORT } from "@cbd/analysis";
import { PrismaService } from "./prisma.service";
import { PrismaScoreRepository } from "./prisma-score-repository";
import { DailyFreeTierAdapter } from "./daily-free-tier-adapter";
import { AnalysisJobRepository } from "./analysis-job-repository";
import { RedisHeadCallRateLimiterAdapter } from "./redis-head-call-rate-limiter-adapter";

// See design: "NestJS Wiring" - libs/persistence.
// useFactory (not useClass), same reasoning documented for RepoSourceModule
// / AnalyzersModule / LlmModule: PrismaScoreRepository and
// DailyFreeTierAdapter take a plain `PrismaClient` constructor param
// (PrismaService IS-A PrismaClient), which Nest's reflection-based
// constructor injection resolves fine when injected explicitly via
// useFactory, but there is no reason to rely on ambient reflection here when
// an explicit factory is just as simple and consistent with the rest of the
// codebase's adapter wiring.
//
// `@Global()`: resolves the DI gap flagged in analysis.module.ts (Nest
// wouldn't otherwise let AnalysisDomainModule's RepoAnalysisService see
// SCORE_REPOSITORY_PORT/USAGE_QUOTA_PORT). See analysis.module.ts's comment
// for why this is `@Global()` and not a direct AnalysisDomainModule import
// (the latter would create a real circular PACKAGE dependency: this module
// already imports FROM @cbd/analysis for the two tokens above).
@Global()
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
    // AnalysisJobRepository is deliberately NOT one of the 5 hexagonal
    // ports (see analysis-job-repository.ts's doc comment) — it's plain
    // job/queue-lifecycle bookkeeping infra, so it's provided directly by
    // class (like PrismaService itself), not behind a Symbol token.
    {
      provide: AnalysisJobRepository,
      useFactory: (prisma: PrismaService) => new AnalysisJobRepository(prisma),
      inject: [PrismaService],
    },
    // Same "plain env var, sane localhost default" style already
    // established by libs/jobs/src/jobs-producer.module.ts's BullMQ
    // connection config — reuses that exact REDIS_HOST/REDIS_PORT
    // convention rather than inventing a new one or a shared config module.
    // A fresh, dedicated ioredis client (not shared with BullMQ's own
    // internal connection) — this is a separate, lightweight, disposable
    // counter, not part of the queue.
    {
      provide: HEAD_CALL_RATE_LIMITER_PORT,
      useFactory: () =>
        new RedisHeadCallRateLimiterAdapter(
          new Redis({
            host: process.env.REDIS_HOST ?? "localhost",
            port: Number(process.env.REDIS_PORT ?? 6379),
          }),
        ),
    },
  ],
  exports: [
    PrismaService,
    SCORE_REPOSITORY_PORT,
    USAGE_QUOTA_PORT,
    AnalysisJobRepository,
    HEAD_CALL_RATE_LIMITER_PORT,
  ],
})
export class PersistenceModule {}
