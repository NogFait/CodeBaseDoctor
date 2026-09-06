import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { startGitFixtureServer, waitForPort, type GitFixtureServer } from "@cbd/repo-source/testing/git-fixture-server";
import {
  startE2eEnvironment,
  pollUntilTerminal,
  type AnalysisPollResponse,
  type E2eEnvironment,
} from "./support/e2e-environment";
import { DEFAULT_ARCHITECTURE_VERDICT, DEFAULT_DOCUMENTATION_VERDICT } from "./support/default-verdicts";

/**
 * Task 8.1 (Phase 8) — full pipeline happy path. Real HTTP `ApiModule`, a
 * real running `WorkerModule` (its `AnalysisProcessor` genuinely dequeuing
 * from a real BullMQ `Worker`), real Testcontainers Postgres + Redis, real
 * Docker ingestion (`ShallowCloneAdapter` cloning a real fixture repo
 * served by `git-fixture-server`), and all 6 REAL `CategoryAnalyzer`s —
 * except Architecture/Documentation's LLM judge, scripted via
 * `ScriptedJudge` (see `startE2eEnvironment`). This scenario is about the
 * FULL PIPELINE completing cleanly, not about Security specifically (see
 * `security-findings.e2e.spec.ts` for that) — the fixture repo has no
 * planted security findings, just enough real content (a README, a test
 * file, a CI config) for Testing/Documentation/Maintainability to have
 * something real to measure.
 */
const REPO_URL = "https://github.com/e2e-fixture/happy-path-repo";

describe("E2E: full pipeline happy path (task 8.1)", () => {
  let env: E2eEnvironment;
  let fixtureServer: GitFixtureServer;

  beforeAll(async () => {
    fixtureServer = startGitFixtureServer([
      {
        name: "happy-path-repo",
        files: {
          "README.md": [
            "# Happy Path Repo",
            "",
            "A tiny, deliberately clean fixture repo for the E2E happy-path test.",
            "Run `npm test` to execute the test suite.",
            "",
          ].join("\n"),
          "src/index.ts": ["export function add(a: number, b: number): number {", "  return a + b;", "}", ""].join("\n"),
          "src/index.spec.ts": [
            'import { describe, expect, it } from "vitest";',
            'import { add } from "./index";',
            "",
            'describe("add", () => {',
            '  it("adds two numbers", () => {',
            "    expect(add(2, 3)).toBe(5);",
            "  });",
            "});",
            "",
          ].join("\n"),
          ".github/workflows/ci.yml": ["name: CI", "on: [push]", "jobs:", "  test:", "    runs-on: ubuntu-latest", "    steps:", "      - run: echo ok", ""].join(
            "\n",
          ),
        },
      },
    ]);
    await waitForPort(fixtureServer.port, "127.0.0.1", 5000);

    env = await startE2eEnvironment();
    env.repoSource.register(REPO_URL, `${fixtureServer.baseUrl}/happy-path-repo`);
    env.judgeScript.set("architecture", DEFAULT_ARCHITECTURE_VERDICT);
    env.judgeScript.set("documentation", DEFAULT_DOCUMENTATION_VERDICT);
  }, 180_000);

  afterAll(async () => {
    fixtureServer.stop();
    await env.stop();
  });

  it(
    "POST enqueues, GET polling observes progress, job completes with all 6 categories scored",
    async () => {
      const postRes = await request(env.apiServer).post("/analyses").send({ repoUrl: REPO_URL });

      expect(postRes.status).toBe(202);
      expect(postRes.body.status).toBe("queued");
      expect(typeof postRes.body.jobId).toBe("string");
      const jobId = postRes.body.jobId as string;

      // Best-effort: try to observe a genuinely in-flight snapshot (at
      // least one category scored/running while another is still
      // pending/running) before the job finishes — task 4.4's whole point
      // was live per-category progress. Timing-dependent by nature (a fast
      // local Docker pipeline can race past this window), so this is
      // informational, not the test's pass/fail criterion — the coarse
      // "eventually all 6 scored" assertion below is that criterion.
      let sawInFlightProgress = false;
      for (let i = 0; i < 40; i++) {
        const res = await request(env.apiServer).get(`/analyses/${jobId}`);
        const body = res.body as AnalysisPollResponse;
        if (body.status !== "analyzing") break;
        const categories = body.progress?.categories ?? [];
        const hasProgressed = categories.some((c) => c.status === "scored" || c.status === "running");
        const hasPending = categories.some((c) => c.status === "pending");
        if (hasProgressed && hasPending) {
          sawInFlightProgress = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      const final = await pollUntilTerminal(env.apiServer, jobId, { timeoutMs: 170_000 });

      expect(final.status).toBe("completed");
      expect(final.result).toBeDefined();
      const result = final.result!;
      expect(result.status).toBe("complete");
      expect(result.categories).toHaveLength(6);
      expect(result.categories.every((c) => c.status === "scored")).toBe(true);
      expect(result.categories.map((c) => c.category).sort()).toEqual(
        ["architecture", "documentation", "maintainability", "performance", "security", "testing"].sort(),
      );

      if (!sawInFlightProgress) {
        // eslint-disable-next-line no-console
        console.warn(
          "E2E happy-path: never observed a genuinely in-flight progress snapshot (local Docker pipeline ran faster than the poll interval) — non-fatal.",
        );
      }
    },
    180_000,
  );
});
