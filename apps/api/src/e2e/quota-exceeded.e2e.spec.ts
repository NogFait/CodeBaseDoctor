import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { startGitFixtureServer, waitForPort, type GitFixtureServer } from "@cbd/repo-source/testing/git-fixture-server";
import { startE2eEnvironment, type E2eEnvironment } from "./support/e2e-environment";

/**
 * Task 8.3 (Phase 8) — quota exceeded -> 429. Real HTTP `ApiModule`, real
 * `DailyFreeTierAdapter`, real Testcontainers Postgres — proving the REAL
 * quota logic actually rejects, not a fake port.
 *
 * Architectural decision (see `e2e-environment.ts`'s `StartE2eEnvironmentOptions`
 * doc comment): rather than driving 5 real ~60-90s full pipeline runs to
 * legitimately exhaust the production default limit of 5, this test starts
 * the environment with `quotaLimit: 1` — a real `DailyFreeTierAdapter`
 * against the real Testcontainers Postgres, just constructed with a lower
 * limit. The FIRST `POST /analyses` consumes the only unit and is enqueued
 * normally; we do NOT need to wait for that job to finish — quota is
 * consumed (`SubmitAnalysisUseCase.submit()`) strictly BEFORE the job row is
 * even created, so the second POST's 429 outcome is already decided the
 * instant the first POST's response comes back.
 */
const REPO_URL = "https://github.com/e2e-fixture/quota-exceeded-repo";

describe("E2E: quota exceeded -> 429 (task 8.3)", () => {
  let env: E2eEnvironment;
  let fixtureServer: GitFixtureServer;

  beforeAll(async () => {
    fixtureServer = startGitFixtureServer([
      { name: "quota-exceeded-repo", files: { "README.md": "# Quota Exceeded Repo\n" } },
    ]);
    await waitForPort(fixtureServer.port, "127.0.0.1", 5000);

    env = await startE2eEnvironment({ quotaLimit: 1 });
    env.repoSource.register(REPO_URL, `${fixtureServer.baseUrl}/quota-exceeded-repo`);
  }, 180_000);

  afterAll(async () => {
    fixtureServer.stop();
    // The FIRST job (quota unit consumed) is deliberately never awaited to
    // completion in the test body — see the class doc comment. It is very
    // likely still mid-flight (real Docker clone/scan) when this runs.
    // `workerApp.close()` triggers BullMQ's graceful worker shutdown, which
    // waits for that in-flight job to finish (including its own `finally {
    // workspace.dispose() }` volume cleanup) rather than killing it —
    // correct behavior, but slower than the default 10s hook timeout.
    await env.stop();
  }, 200_000);

  it(
    "second POST with quota exhausted (limit 1) gets 429 problem+json with Retry-After; no second job enqueued",
    async () => {
      const first = await request(env.apiServer).post("/analyses").send({ repoUrl: REPO_URL });
      expect(first.status).toBe(202);
      expect(first.body.quota).toMatchObject({ limit: 1, remaining: 0 });

      const second = await request(env.apiServer).post("/analyses").send({ repoUrl: REPO_URL });

      expect(second.status).toBe(429);
      expect(second.headers["content-type"]).toContain("application/problem+json");
      expect(second.body.type).toBe("/errors/quota-exceeded");
      expect(second.body.status).toBe(429);
      expect(second.body.limit).toBe(1);
      expect(second.body.remaining).toBe(0);
      expect(typeof second.body.upgradeUrl).toBe("string");
      expect(second.headers["retry-after"]).toBeDefined();
      expect(Number(second.headers["retry-after"])).toBeGreaterThanOrEqual(0);

      // Confirms the rejection happened BEFORE any job row was created —
      // not just that the HTTP response looked right.
      const jobCount = await env.db.prisma.analysisJob.count();
      expect(jobCount).toBe(1);
    },
    60_000,
  );
});
