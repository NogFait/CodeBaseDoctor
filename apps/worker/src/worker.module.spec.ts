import "reflect-metadata";
import { Module } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { RepoAnalysisService, REPO_SOURCE_PORT, SCORE_REPOSITORY_PORT, USAGE_QUOTA_PORT, CATEGORY_ANALYZERS } from "@cbd/analysis";
import { ShallowCloneAdapter } from "@cbd/repo-source";
import { PrismaScoreRepository, DailyFreeTierAdapter } from "@cbd/persistence";
import { JobsConsumerModule } from "@cbd/jobs";
import { WorkerModule } from "./worker.module";

/**
 * Task A (apply-progress batch, see engram sdd/codebase-doctor-mvp/apply-progress):
 * proves the previously-flagged Nest DI gap in AnalysisDomainModule is
 * resolved for the real composed app (WorkerModule), which is exactly the
 * shape apps/worker/src/main.ts bootstraps in production
 * (`NestFactory.createApplicationContext(WorkerModule)`).
 *
 * `.compile()` alone (no `.init()`/`app.init()`) is enough: Nest eagerly
 * instantiates every registered provider in the module graph during
 * compile, including RepoAnalysisService's constructor, which is exactly
 * where UnknownDependenciesException would previously have been thrown for
 * the four @Inject()ed port tokens. None of the real adapters make network
 * calls or connect to anything at construction time (ShallowCloneAdapter's
 * Docker socket, AnthropicJudgeAdapter's SDK client, and PrismaService's
 * $connect() are all lazy / gated behind lifecycle hooks Nest doesn't run
 * on a bare `.compile()`), so this needs no real Docker/Postgres/Anthropic
 * credentials.
 *
 * `JobsConsumerModule` is swapped for a fake via `.overrideModule()` — same
 * pattern and same reason as `apps/api/src/api.module.spec.ts`'s
 * `FakeJobsProducerModule`: since task 6.2, `JobsConsumerModule` calls
 * `BullModule.forRoot()`/`registerQueue()` for real, which eagerly
 * constructs a live ioredis-backed Queue on module compile — confirmed via
 * a genuine RED (`ECONNREFUSED 127.0.0.1:6379`) the moment this module was
 * wired for real. The real BullMQ/Redis consumer path (the actual
 * `AnalysisProcessor` dequeuing real jobs) is covered separately by
 * `libs/jobs/src/analysis-processor.integration.spec.ts` (real
 * Testcontainers Redis + Postgres). This test's own job is unchanged:
 * proving WorkerModule's OWN graph (RepoAnalysisService + its 4 ports)
 * resolves — nothing here needs the queue to be real.
 */
@Module({})
class FakeJobsConsumerModule {}

describe("WorkerModule wiring (Task A: AnalysisDomainModule DI gap)", () => {
  it("resolves RepoAnalysisService with its four real port tokens bound to the real infra adapters", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideModule(JobsConsumerModule)
      .useModule(FakeJobsConsumerModule)
      .compile();

    const service = moduleRef.get(RepoAnalysisService);
    expect(service).toBeInstanceOf(RepoAnalysisService);

    // Not just "resolves to *something*" — prove the tokens are bound to the
    // REAL infra adapters (not a stub/double), i.e. AnalysisDomainModule is
    // genuinely seeing PersistenceModule/RepoSourceModule/LlmModule's
    // exports, not some accidental fallback.
    expect(moduleRef.get(REPO_SOURCE_PORT)).toBeInstanceOf(ShallowCloneAdapter);
    expect(moduleRef.get(SCORE_REPOSITORY_PORT)).toBeInstanceOf(PrismaScoreRepository);
    expect(moduleRef.get(USAGE_QUOTA_PORT)).toBeInstanceOf(DailyFreeTierAdapter);

    const analyzers = moduleRef.get(CATEGORY_ANALYZERS) as readonly { category: string }[];
    expect(analyzers).toHaveLength(6);
    expect(analyzers.map((a) => a.category).sort()).toEqual([
      "architecture",
      "documentation",
      "maintainability",
      "performance",
      "security",
      "testing",
    ]);
  });
});
