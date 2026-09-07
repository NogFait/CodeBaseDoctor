import "reflect-metadata";
import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { HEAD_CALL_RATE_LIMITER_PORT, REPO_SOURCE_PORT, SCORE_REPOSITORY_PORT, USAGE_QUOTA_PORT } from "@cbd/analysis";
import { ShallowCloneAdapter } from "@cbd/repo-source";
import { PrismaScoreRepository, DailyFreeTierAdapter } from "@cbd/persistence";
import { JobsProducerModule } from "@cbd/jobs";
import { AnalysisQueueProducer } from "@cbd/jobs";
import { ApiModule } from "./api.module";
import { AnalysesController } from "./analyses/analyses.controller";
import { SubmitAnalysisUseCase } from "./analyses/submit-analysis.use-case";

/**
 * Task A wiring regression test — same shape as
 * apps/worker/src/worker.module.spec.ts's "Task A: AnalysisDomainModule DI
 * gap" test, but for ApiModule. Proves the exact bug class flagged in
 * apply-progress batch 2026-09-04 Learned #2 (ApiModule importing
 * AnalysisDomainModule would always throw UnknownDependenciesException for
 * CATEGORY_ANALYZERS/REPO_SOURCE_PORT/LLM_JUDGE_PORT, since apps/api's
 * graph never loads AnalyzersModule/LlmModule) cannot recur: AnalysesController
 * and SubmitAnalysisUseCase must resolve fully under the REAL composed
 * ApiModule graph, with REPO_SOURCE_PORT bound to the real ShallowCloneAdapter.
 *
 * JobsProducerModule is swapped for a fake via `.overrideModule()` rather
 * than imported for real: `BullModule.forRoot()`/`registerQueue()` eagerly
 * construct a real ioredis-backed Queue on module compile, which would
 * require a live Redis connection just to prove DI wiring — an
 * unnecessary, flaky dependency for what this test actually needs to prove
 * (ApiModule's OWN module graph is correctly composed). The real
 * BullMQ/Redis producer path is covered separately by
 * libs/jobs/src/analysis-queue-producer.integration.spec.ts (real
 * Testcontainers Redis).
 *
 * HEAD_CALL_RATE_LIMITER_PORT (Fix C) is overridden for the SAME reason:
 * PersistenceModule's real binding constructs its own real ioredis client
 * (RedisHeadCallRateLimiterAdapter) on module compile — a live-Redis
 * dependency this DI-wiring-only test doesn't need and shouldn't leave a
 * dangling reconnect-retrying connection behind after `moduleRef.close()`.
 * The real Redis-backed path is covered separately by
 * libs/persistence/src/redis-head-call-rate-limiter-adapter.integration.spec.ts
 * (real Testcontainers Redis).
 */
@Module({
  providers: [{ provide: AnalysisQueueProducer, useValue: { enqueue: async () => "fake-bull-job-id" } }],
  exports: [AnalysisQueueProducer],
})
class FakeJobsProducerModule {}

describe("ApiModule wiring (Task A: apps/api never imports AnalysisDomainModule/AnalyzersModule/LlmModule)", () => {
  it("resolves AnalysesController and SubmitAnalysisUseCase with REPO_SOURCE_PORT/SCORE_REPOSITORY_PORT/USAGE_QUOTA_PORT bound to the real infra adapters", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
      .overrideModule(JobsProducerModule)
      .useModule(FakeJobsProducerModule)
      .overrideProvider(HEAD_CALL_RATE_LIMITER_PORT)
      .useValue({ checkAndRecord: async () => {} })
      .compile();

    const controller = moduleRef.get(AnalysesController);
    expect(controller).toBeInstanceOf(AnalysesController);

    const useCase = moduleRef.get(SubmitAnalysisUseCase);
    expect(useCase).toBeInstanceOf(SubmitAnalysisUseCase);

    // Not just "resolves to *something*" — prove the tokens are the REAL
    // infra adapters (same assertion style as worker.module.spec.ts), i.e.
    // RepoSourceModule/PersistenceModule's real exports, not an accidental
    // fallback.
    expect(moduleRef.get(REPO_SOURCE_PORT)).toBeInstanceOf(ShallowCloneAdapter);
    expect(moduleRef.get(SCORE_REPOSITORY_PORT)).toBeInstanceOf(PrismaScoreRepository);
    expect(moduleRef.get(USAGE_QUOTA_PORT)).toBeInstanceOf(DailyFreeTierAdapter);

    await moduleRef.close();
  });
});
