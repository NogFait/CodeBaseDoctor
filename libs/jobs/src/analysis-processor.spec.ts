import { describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { AnalyzeRepoRequest, RepoScan } from "@cbd/analysis";
import { AnalysisProcessor, type AnalysisJobData } from "./analysis-processor";

// Fast unit spec (no Testcontainers): the processor's ONLY job here is
// wiring — does a field on the dequeued job's data reach
// RepoAnalysisService.analyze()? The full dequeue/lock/settle mechanics and
// the DB row transitions are covered by analysis-processor.integration.spec.ts.

function fakeScan(): RepoScan {
  return {
    id: "scan-1",
    repoUrl: "https://github.com/fixture/well-tested-ts",
    commitSha: "a".repeat(40),
    engineVersion: "test-engine",
    status: "complete",
    compositeScore: 80,
    completeness: 1,
    dominantLanguage: "TypeScript",
    languageMix: [],
    categories: [],
    createdAt: new Date(),
  };
}

function buildProcessor(analyzeImpl: () => Promise<RepoScan> = async () => fakeScan()) {
  const analyze = vi.fn(
    (_request: AnalyzeRepoRequest, _onProgress?: unknown): Promise<RepoScan> => analyzeImpl(),
  );
  const service = { analyze } as unknown as ConstructorParameters<typeof AnalysisProcessor>[0];
  const jobs = {
    updateStatus: vi.fn(async () => {}),
    updateCategoryStatus: vi.fn(async () => {}),
  } as unknown as ConstructorParameters<typeof AnalysisProcessor>[1];
  const quota = {
    refund: vi.fn(async () => {}),
  } as unknown as ConstructorParameters<typeof AnalysisProcessor>[2];
  const processor = new AnalysisProcessor(service, jobs, quota);
  return { processor, analyze, jobs, quota };
}

function jobWith(data: Partial<AnalysisJobData>): Job<AnalysisJobData> {
  return {
    data: {
      analysisJobId: "job-1",
      repoUrl: "https://github.com/fixture/well-tested-ts",
      actorId: "actor-1",
      reservationId: "reservation-1",
      ...data,
    },
  } as unknown as Job<AnalysisJobData>;
}

describe("AnalysisProcessor — forceRescan wiring", () => {
  it("passes forceRescan:true from the job data straight through to RepoAnalysisService.analyze()", async () => {
    const { processor, analyze } = buildProcessor();

    await processor.process(jobWith({ forceRescan: true }));

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0][0]).toMatchObject({
      repoUrl: "https://github.com/fixture/well-tested-ts",
      actorId: "actor-1",
      reservationId: "reservation-1",
      forceRescan: true,
    });
  });

  it("does NOT set forceRescan when the job data omits it (default path unchanged)", async () => {
    const { processor, analyze } = buildProcessor();

    await processor.process(jobWith({}));

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0][0].forceRescan).toBeFalsy();
  });
});
