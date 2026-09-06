import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { startGitFixtureServer, waitForPort, type GitFixtureServer } from "@cbd/repo-source/testing/git-fixture-server";
import { startE2eEnvironment, pollUntilTerminal, type E2eEnvironment } from "./support/e2e-environment";
import { DEFAULT_ARCHITECTURE_VERDICT, DEFAULT_DOCUMENTATION_VERDICT } from "./support/default-verdicts";

/**
 * Task 8.2 (Phase 8) — cache-hit short-circuit, design flow (b). The FIRST
 * `POST /analyses` for a repo+commit-SHA goes through the full 8.1-style
 * flow to completion; a SECOND `POST /analyses` for the identical
 * `repoUrl` (same resolved commit SHA, `forceRescan` omitted) must return
 * `200` immediately with `cached:true` and the same result, WITHOUT
 * enqueueing a new job or consuming quota.
 *
 * Proof, concretely (per the task brief, "your call on the most direct way
 * without over-engineering"):
 *  1. `analysis_job` row count in the REAL Postgres does not change across
 *     the second POST (queried directly via `env.db.prisma` — no proxy
 *     metric).
 *  2. `quota.remaining` reported in the second POST's own response body is
 *     IDENTICAL to what the first POST's response already reported (after
 *     that first request's one real `consume()`) — a cache hit only ever
 *     calls `UsageQuotaPort.peek()`, never `consume()`, so a second unit
 *     is never subtracted.
 */
const REPO_URL = "https://github.com/e2e-fixture/cache-hit-repo";

describe("E2E: cache-hit short-circuit (task 8.2)", () => {
  let env: E2eEnvironment;
  let fixtureServer: GitFixtureServer;

  beforeAll(async () => {
    fixtureServer = startGitFixtureServer([
      {
        name: "cache-hit-repo",
        files: {
          "README.md": "# Cache Hit Repo\n\nFixture for the E2E cache-hit-short-circuit test.\n",
          "src/index.ts": ["export function double(n: number): number {", "  return n * 2;", "}", ""].join("\n"),
        },
      },
    ]);
    await waitForPort(fixtureServer.port, "127.0.0.1", 5000);

    env = await startE2eEnvironment();
    env.repoSource.register(REPO_URL, `${fixtureServer.baseUrl}/cache-hit-repo`);
    env.judgeScript.set("architecture", DEFAULT_ARCHITECTURE_VERDICT);
    env.judgeScript.set("documentation", DEFAULT_DOCUMENTATION_VERDICT);
  }, 180_000);

  afterAll(async () => {
    fixtureServer.stop();
    await env.stop();
  });

  it(
    "second submission of the same repo+SHA is a 200 cache hit: no new job row, no quota consumed",
    async () => {
      const firstPost = await request(env.apiServer).post("/analyses").send({ repoUrl: REPO_URL });
      expect(firstPost.status).toBe(202);
      expect(firstPost.body.status).toBe("queued");
      const jobId = firstPost.body.jobId as string;
      const quotaRemainingAfterFirstConsume = firstPost.body.quota.remaining as number;

      const final = await pollUntilTerminal(env.apiServer, jobId, { timeoutMs: 170_000 });
      expect(final.status).toBe("completed");
      expect(final.result).toBeDefined();

      const jobRowCountBeforeSecondPost = await env.db.prisma.analysisJob.count();

      const secondPost = await request(env.apiServer).post("/analyses").send({ repoUrl: REPO_URL });

      expect(secondPost.status).toBe(200);
      expect(secondPost.body.status).toBe("completed");
      expect(secondPost.body.cached).toBe(true);
      expect(secondPost.body.jobId).toBeNull();
      expect(secondPost.body.result).toBeDefined();
      expect(secondPost.body.result.categories).toHaveLength(6);
      expect(secondPost.body.result.categories.every((c: { status: string }) => c.status === "scored")).toBe(true);
      // Same underlying scan — same scanId as the completed job's own result.
      expect(secondPost.body.scanId).toBe(final.result!.id);

      const jobRowCountAfterSecondPost = await env.db.prisma.analysisJob.count();
      expect(jobRowCountAfterSecondPost).toBe(jobRowCountBeforeSecondPost);

      expect(secondPost.body.quota.remaining).toBe(quotaRemainingAfterFirstConsume);
    },
    180_000,
  );
});
