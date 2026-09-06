import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { CategoryAnalyzer, CategoryId, CategoryScore } from "@cbd/analysis";
import { StubAnalyzer } from "@cbd/analysis/testing/stub-analyzer";
import { startGitFixtureServer, waitForPort, type GitFixtureServer } from "@cbd/repo-source/testing/git-fixture-server";
import { startE2eEnvironment, pollUntilTerminal, type E2eEnvironment } from "./support/e2e-environment";

/**
 * Task 8.6 (Phase 8) — 3+ of 6 categories fail -> job 'failed', quota
 * refunded (spec `analysis-orchestration`'s "Three or more analyzers fail,
 * job fails and quota is refunded" scenario; `usage-quota`'s "Refund quota
 * when a job fails below the completeness threshold").
 *
 * DELIBERATE SCOPE DECISION (documented per the orchestrator's own
 * instruction, mirroring how prior batches documented similar calls):
 * deterministically forcing 3+ REAL analyzers to fail on demand isn't
 * practically achievable without contrived hacks — only 2 of 6 categories
 * (Architecture, Documentation) route through the swappable `ScriptedJudge`;
 * the other 4 are real heuristics/Semgrep with no clean "fail on demand"
 * seam (fragile fixture engineering or artificial timeouts, neither exposed
 * cleanly by this harness today). This scenario tests the ORCHESTRATION /
 * refund logic under a below-threshold outcome — NOT any individual
 * analyzer's own real failure behavior (Architecture's real failure path is
 * already covered by `partial-completion.e2e.spec.ts`, task 8.5). So: the
 * worker app's `CATEGORY_ANALYZERS` array is entirely overridden with 6
 * `StubAnalyzer`s (3 scripted to throw, 3 scripted to succeed) via
 * `startE2eEnvironment({ categoryAnalyzers })` — see that option's own doc
 * comment in `e2e-environment.ts`. This is NOT a fully-synthetic test: the
 * `repoUrl` still goes through a REAL clone via `E2eRepoSource` + a real
 * `git-fixture-server` — only the analyzer LAYER is faked, not ingestion.
 *
 * Quota-refund verification: checked directly against the real
 * `quota_reservation` row (via the failed job's own `reservationId`) rather
 * than an indirect follow-up-POST proxy — the most direct proof that
 * `UsageQuotaPort.refund()` actually ran, and it doesn't require a second
 * real Docker pipeline run (or a `quotaLimit` override) just to observe a
 * 429-vs-202 side effect.
 */
const REPO_URL = "https://github.com/e2e-fixture/below-threshold-repo";

const SUCCEEDING_CATEGORIES: readonly CategoryId[] = ["architecture", "documentation", "performance"];
const FAILING_CATEGORIES: readonly CategoryId[] = ["security", "testing", "maintainability"];

function stubbedScore(category: CategoryId): CategoryScore {
  return {
    category,
    status: "scored",
    score: 80,
    confidence: "measured",
    weightCap: category === "performance" ? 0.5 : 1,
    rationale: "Stubbed for E2E task 8.6 (below-threshold + refund) — see spec doc comment.",
    findings: [],
    durationMs: 1,
  };
}

function buildCategoryAnalyzers(): readonly CategoryAnalyzer[] {
  const succeeding = SUCCEEDING_CATEGORIES.map(
    (category) => new StubAnalyzer({ category, result: stubbedScore(category) }),
  );
  const failing = FAILING_CATEGORIES.map(
    (category) => new StubAnalyzer({ category, error: new Error(`Stubbed analyzer failure (task 8.6): ${category}`) }),
  );
  return [...succeeding, ...failing];
}

describe("E2E: 3+ analyzers fail -> job failed, quota refunded (task 8.6)", () => {
  let env: E2eEnvironment;
  let fixtureServer: GitFixtureServer;

  beforeAll(async () => {
    fixtureServer = startGitFixtureServer([
      { name: "below-threshold-repo", files: { "README.md": "# Below Threshold Repo\n" } },
    ]);
    await waitForPort(fixtureServer.port, "127.0.0.1", 5000);

    env = await startE2eEnvironment({ categoryAnalyzers: buildCategoryAnalyzers() });
    env.repoSource.register(REPO_URL, `${fixtureServer.baseUrl}/below-threshold-repo`);
    // No judgeScript.set() calls needed — the real ArchitectureAnalyzer/
    // DocumentationAnalyzer never run; they're replaced entirely by
    // StubAnalyzer instances above.
  }, 180_000);

  afterAll(async () => {
    fixtureServer.stop();
    await env.stop();
  });

  it(
    "job fails when only 3/6 categories score (3 stubbed failures); no RepoScan persisted, quota reservation refunded",
    async () => {
      const postRes = await request(env.apiServer).post("/analyses").send({ repoUrl: REPO_URL });
      expect(postRes.status).toBe(202);
      const jobId = postRes.body.jobId as string;

      const final = await pollUntilTerminal(env.apiServer, jobId, { timeoutMs: 90_000 });

      expect(final.status).toBe("failed");
      expect(final.result).toBeUndefined();

      const jobRow = await env.db.prisma.analysisJob.findUniqueOrThrow({
        where: { id: jobId },
        include: { categories: true },
      });
      expect(jobRow.status).toBe("failed");
      expect(jobRow.repoScanId).toBeNull();
      expect(jobRow.errorCode).toBe("AnalysisBelowThresholdError");

      const reservation = await env.db.prisma.quotaReservation.findUniqueOrThrow({
        where: { id: jobRow.reservationId },
      });
      expect(reservation.state).toBe("refunded");

      // Every category row still reflects a real, individual outcome — no
      // slot silently dropped, matching the same "never a missing slot"
      // invariant real analyzer failures uphold (task 8.5).
      const categories = jobRow.categories;
      expect(categories).toHaveLength(6);
      for (const category of FAILING_CATEGORIES) {
        const row = categories.find((c) => c.category === category);
        expect(row?.status).toBe("failed");
      }
      for (const category of SUCCEEDING_CATEGORIES) {
        const row = categories.find((c) => c.category === category);
        expect(row?.status).toBe("scored");
      }
    },
    120_000,
  );
});
