import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { startGitFixtureServer, waitForPort, type GitFixtureServer } from "@cbd/repo-source/testing/git-fixture-server";
import { startE2eEnvironment, pollUntilTerminal, type E2eEnvironment } from "./support/e2e-environment";
import { DEFAULT_DOCUMENTATION_VERDICT } from "./support/default-verdicts";

/**
 * Task 8.5 (Phase 8) — one analyzer fails, job still completes as
 * `completed_partial` (design flow (c), spec `analysis-orchestration`'s "One
 * analyzer fails, job still completes as partial" scenario).
 *
 * 100% REAL analyzers, no stubbing needed: Architecture is the ONE category
 * scripted to fail, by scripting `judgeScript.set("architecture", new
 * Error(...))` — `ArchitectureAnalyzer.analyze()` propagates a thrown judge
 * error unwrapped (see architecture-analyzer.ts), and `AnalyzerRunner`
 * catches it and turns it into a `CategoryScore{status:'failed'}` (see
 * analyzer-runner.ts's `toFailedScore`) — never a missing slot. The other 5
 * categories run for real: Security/Testing/Maintainability/Performance are
 * 100% real heuristics/Semgrep against a normal clean fixture; Documentation
 * still gets a normal scripted verdict (it's LLM-judge-backed too, but this
 * scenario is about Architecture specifically, not Documentation).
 */
const REPO_URL = "https://github.com/e2e-fixture/partial-completion-repo";

describe("E2E: one analyzer fails -> completed_partial (task 8.5)", () => {
  let env: E2eEnvironment;
  let fixtureServer: GitFixtureServer;

  beforeAll(async () => {
    fixtureServer = startGitFixtureServer([
      {
        name: "partial-completion-repo",
        files: {
          "README.md": [
            "# Partial Completion Repo",
            "",
            "Fixture for the E2E one-analyzer-fails test (task 8.5).",
            "Run `npm test` to execute the test suite.",
            "",
          ].join("\n"),
          "src/index.ts": ["export function subtract(a: number, b: number): number {", "  return a - b;", "}", ""].join(
            "\n",
          ),
          "src/index.spec.ts": [
            'import { describe, expect, it } from "vitest";',
            'import { subtract } from "./index";',
            "",
            'describe("subtract", () => {',
            '  it("subtracts two numbers", () => {',
            "    expect(subtract(5, 3)).toBe(2);",
            "  });",
            "});",
            "",
          ].join("\n"),
        },
      },
    ]);
    await waitForPort(fixtureServer.port, "127.0.0.1", 5000);

    env = await startE2eEnvironment();
    env.repoSource.register(REPO_URL, `${fixtureServer.baseUrl}/partial-completion-repo`);
    // The ONE scripted failure for this scenario.
    env.judgeScript.set("architecture", new Error("architecture judge unavailable (scripted failure, task 8.5)"));
    env.judgeScript.set("documentation", DEFAULT_DOCUMENTATION_VERDICT);
  }, 180_000);

  afterAll(async () => {
    fixtureServer.stop();
    await env.stop();
  });

  it(
    "job completes as completed_partial: 5/6 scored for real, architecture failed with an error reason, quota kept",
    async () => {
      const postRes = await request(env.apiServer).post("/analyses").send({ repoUrl: REPO_URL });
      expect(postRes.status).toBe(202);
      const jobId = postRes.body.jobId as string;

      const final = await pollUntilTerminal(env.apiServer, jobId, { timeoutMs: 170_000 });

      expect(final.status).toBe("completed_partial");
      expect(final.result).toBeDefined();
      const result = final.result!;
      expect(result.status).toBe("partial");
      // `completeness` is a Postgres NUMERIC(3,2) column (see schema.prisma)
      // — it round-trips as 0.83, not the full-precision 5/6 = 0.8333...
      expect(result.completeness).toBeCloseTo(0.83, 2);
      expect(result.categories).toHaveLength(6);

      const architecture = result.categories.find((c) => c.category === "architecture");
      expect(architecture).toBeDefined();
      expect(architecture!.status).toBe("failed");
      expect(architecture!.score).toBeNull();
      expect(architecture!.error).toBeDefined();
      expect(architecture!.error?.message).toContain("architecture judge unavailable");

      const scored = result.categories.filter((c) => c.status === "scored");
      expect(scored).toHaveLength(5);
      expect(scored.map((c) => c.category).sort()).toEqual(
        ["documentation", "maintainability", "performance", "security", "testing"].sort(),
      );

      // Quota NOT refunded: >= 4-of-6 scored delivers a usable report, so
      // the reservation this job consumed must stay 'consumed'. Checked
      // directly against the real `quota_reservation` row via the job's own
      // `reservationId` — the most direct proof of `UsageQuotaPort.refund()`
      // NOT having been called, more so than an indirect follow-up-POST
      // proxy (which would also cost a second real Docker pipeline run for
      // no extra signal).
      const jobRow = await env.db.prisma.analysisJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(jobRow.status).toBe("completed_partial");
      const reservation = await env.db.prisma.quotaReservation.findUniqueOrThrow({
        where: { id: jobRow.reservationId },
      });
      expect(reservation.state).toBe("consumed");
    },
    180_000,
  );
});
