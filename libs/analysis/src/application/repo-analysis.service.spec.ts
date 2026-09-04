import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FixtureRepoSource } from "@cbd/repo-source/testing/fixture-repo-source";
import { InMemoryScoreRepository } from "@cbd/persistence/testing/in-memory-score-repository";
import { InMemoryQuota } from "@cbd/persistence/testing/in-memory-quota";
import { StubAnalyzer } from "../../testing/stub-analyzer";
import type { CategoryScore } from "../domain";
import { AnalysisBelowThresholdError } from "../domain";
import type { CategoryAnalyzer, RepoScan } from "../ports";
import { RepoAnalysisService } from "./repo-analysis.service";

const FIXTURE_DIR = path.resolve(__dirname, "../../../analyzers/__fixtures__/well-tested-ts");
const REPO_URL = "https://github.com/fixture/well-tested-ts";
const ACTOR_ID = "actor-1";
const RESERVATION_ID = "reservation-1";

function scoredResult(category: CategoryAnalyzer["category"], score = 80): CategoryScore {
  return {
    category,
    status: "scored",
    score,
    confidence: "measured",
    weightCap: category === "performance" ? 0.5 : 1,
    rationale: `${category} looks fine`,
    findings: [],
    durationMs: 5,
  };
}

/** Wraps a StubAnalyzer to also push into a shared order log on analyze(). */
function trackingAnalyzer(stub: StubAnalyzer, order: string[]): CategoryAnalyzer {
  return {
    category: stub.category,
    confidence: stub.confidence,
    analyzerVersion: stub.analyzerVersion,
    analyze: async (ctx, signal) => {
      order.push(`analyze:${stub.category}`);
      return stub.analyze(ctx, signal);
    },
  };
}

function allSixAnalyzers(
  overrides: Partial<Record<CategoryAnalyzer["category"], "score" | "fail">> = {},
): StubAnalyzer[] {
  const categories: CategoryAnalyzer["category"][] = [
    "security",
    "testing",
    "maintainability",
    "architecture",
    "documentation",
    "performance",
  ];
  return categories.map((category) => {
    const mode = overrides[category] ?? "score";
    return mode === "fail"
      ? new StubAnalyzer({ category, error: new Error(`${category} blew up`) })
      : new StubAnalyzer({ category, result: scoredResult(category) });
  });
}

function buildService(analyzers: readonly CategoryAnalyzer[], quota = new InMemoryQuota()) {
  const repoSource = new FixtureRepoSource(FIXTURE_DIR, REPO_URL);
  const scores = new InMemoryScoreRepository();
  const service = new RepoAnalysisService(repoSource, scores, quota, analyzers);
  return { service, scores, quota, repoSource };
}

describe("RepoAnalysisService", () => {
  it("(a) cache hit: returns the cached scan, never consumes quota, never saves again", async () => {
    const { service, scores, quota } = buildService(allSixAnalyzers());

    const first = await service.analyze({ repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId: RESERVATION_ID });
    expect(first.status).toBe("complete");
    expect(quota.consumeCalls).toHaveLength(1);

    const savedCallsBefore = (await scores.listByRepo(REPO_URL, 10)).length;
    const second: RepoScan = await service.analyze({
      repoUrl: REPO_URL,
      actorId: ACTOR_ID,
      reservationId: "reservation-2",
    });

    expect(second.id).toBe(first.id);
    // still exactly 1 consume call from the FIRST (uncached) run — the cache
    // hit on the second call must not call consume() again.
    expect(quota.consumeCalls).toHaveLength(1);
    const savedCallsAfter = (await scores.listByRepo(REPO_URL, 10)).length;
    expect(savedCallsAfter).toBe(savedCallsBefore);
  });

  it("(b) quota is consumed before any analyzer runs (order matters)", async () => {
    const order: string[] = [];
    const quota = new InMemoryQuota();
    const originalConsume = quota.consume.bind(quota);
    quota.consume = async (actorId: string, reservationId: string) => {
      order.push("quota.consume");
      return originalConsume(actorId, reservationId);
    };
    const stubs = allSixAnalyzers();
    const analyzers = stubs.map((s) => trackingAnalyzer(s, order));
    const { service } = buildService(analyzers, quota);

    await service.analyze({ repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId: RESERVATION_ID });

    expect(order[0]).toBe("quota.consume");
    expect(order.slice(1).every((entry) => entry.startsWith("analyze:"))).toBe(true);
    expect(order).toHaveLength(1 + 6);
  });

  it("(c) over-limit: QuotaExceededError propagates and no analyzer ever runs", async () => {
    const order: string[] = [];
    const quota = new InMemoryQuota({ limit: 0 });
    const stubs = allSixAnalyzers();
    const analyzers = stubs.map((s) => trackingAnalyzer(s, order));
    const { service } = buildService(analyzers, quota);

    await expect(
      service.analyze({ repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId: RESERVATION_ID }),
    ).rejects.toThrow(/exceeded/i);

    expect(order).toHaveLength(0);
  });

  it("(d) 6 of 6 scored: saves a 'complete' report, no refund", async () => {
    const { service, quota } = buildService(allSixAnalyzers());

    const scan = await service.analyze({ repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId: RESERVATION_ID });

    expect(scan.status).toBe("complete");
    expect(scan.completeness).toBe(1);
    expect(quota.refundCalls).toHaveLength(0);
  });

  it("(d) 5 of 6 scored: saves a 'partial' report, no refund", async () => {
    const { service, quota } = buildService(allSixAnalyzers({ architecture: "fail" }));

    const scan = await service.analyze({ repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId: RESERVATION_ID });

    expect(scan.status).toBe("partial");
    expect(scan.categories).toHaveLength(6);
    expect(scan.categories.find((c) => c.category === "architecture")?.status).toBe("failed");
    expect(quota.refundCalls).toHaveLength(0);
  });

  it("(d) 4 of 6 scored: still saves a 'partial' report, no refund", async () => {
    const { service, quota } = buildService(
      allSixAnalyzers({ architecture: "fail", documentation: "fail" }),
    );

    const scan = await service.analyze({ repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId: RESERVATION_ID });

    expect(scan.status).toBe("partial");
    expect(quota.refundCalls).toHaveLength(0);
  });

  it("(e) 3 of 6 scored: never saves, refunds quota exactly once, throws AnalysisBelowThresholdError", async () => {
    const { service, scores, quota } = buildService(
      allSixAnalyzers({ architecture: "fail", documentation: "fail", performance: "fail" }),
    );

    await expect(
      service.analyze({ repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId: RESERVATION_ID }),
    ).rejects.toBeInstanceOf(AnalysisBelowThresholdError);

    expect(quota.refundCalls).toEqual([RESERVATION_ID]);
    expect(await scores.listByRepo(REPO_URL, 10)).toHaveLength(0);
  });

  it("(e) the thrown error carries the scoredCount and the underlying report", async () => {
    const { service } = buildService(
      allSixAnalyzers({ architecture: "fail", documentation: "fail", performance: "fail" }),
    );

    try {
      await service.analyze({ repoUrl: REPO_URL, actorId: ACTOR_ID, reservationId: RESERVATION_ID });
      expect.unreachable("expected AnalysisBelowThresholdError to be thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AnalysisBelowThresholdError);
      const err = error as AnalysisBelowThresholdError;
      expect(err.scoredCount).toBe(3);
      expect(err.report.categories).toHaveLength(6);
    }
  });
});
