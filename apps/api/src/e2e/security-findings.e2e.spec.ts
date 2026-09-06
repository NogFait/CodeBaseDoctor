import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { startGitFixtureServer, waitForPort, type GitFixtureServer } from "@cbd/repo-source/testing/git-fixture-server";
import { startE2eEnvironment, pollUntilTerminal, type E2eEnvironment } from "./support/e2e-environment";
import { DEFAULT_ARCHITECTURE_VERDICT, DEFAULT_DOCUMENTATION_VERDICT } from "./support/default-verdicts";

/**
 * Task 8.7 (Phase 8) — Security score reflects real findings, end-to-end.
 * Reuses the exact "dirty-repo" fixture from
 * `libs/analyzers/src/security-analyzer.integration.spec.ts` (hardcoded
 * secret + `eval` + SQL string concatenation + a `package-lock.json`
 * pinning vulnerable `lodash@4.17.15`) so this test proves the SAME result
 * that analyzer-level integration test already proves in isolation, now
 * through the full HTTP + queue + worker + real-Docker pipeline.
 */
const REPO_URL = "https://github.com/e2e-fixture/dirty-repo";
const SEMGREP_RULE_IDS = ["hardcoded-secret", "dangerous-eval", "sql-string-concatenation"];

describe("E2E: security score reflects real findings (task 8.7)", () => {
  let env: E2eEnvironment;
  let fixtureServer: GitFixtureServer;

  beforeAll(async () => {
    fixtureServer = startGitFixtureServer([
      {
        // Same known Semgrep-detectable patterns + vulnerable dependency
        // manifest as security-analyzer.integration.spec.ts's "dirty-repo"
        // fixture — deliberately mirrored, not reinvented.
        name: "dirty-repo",
        files: {
          "app.js": [
            'const apiKey = "sk_live_ABCDEFGH12345678";',
            "function run(userInput) { eval(userInput); }",
            "function q(name) { return \"SELECT * FROM users WHERE name = '\" + name + \"'\"; }",
            "",
          ].join("\n"),
          "package-lock.json": JSON.stringify({
            name: "dirty-repo",
            version: "1.0.0",
            lockfileVersion: 2,
            requires: true,
            packages: {
              "": { name: "dirty-repo", version: "1.0.0" },
              "node_modules/lodash": { version: "4.17.15" },
            },
            dependencies: { lodash: { version: "4.17.15" } },
          }),
        },
      },
    ]);
    await waitForPort(fixtureServer.port, "127.0.0.1", 5000);

    env = await startE2eEnvironment();
    env.repoSource.register(REPO_URL, `${fixtureServer.baseUrl}/dirty-repo`);
    env.judgeScript.set("architecture", DEFAULT_ARCHITECTURE_VERDICT);
    env.judgeScript.set("documentation", DEFAULT_DOCUMENTATION_VERDICT);
  }, 180_000);

  afterAll(async () => {
    fixtureServer.stop();
    await env.stop();
  });

  it(
    "full pipeline: security category scores below 100 with real Semgrep + OSV-Scanner findings",
    async () => {
      const postRes = await request(env.apiServer).post("/analyses").send({ repoUrl: REPO_URL });
      expect(postRes.status).toBe(202);
      const jobId = postRes.body.jobId as string;

      const final = await pollUntilTerminal(env.apiServer, jobId, { timeoutMs: 170_000 });

      expect(final.status).toBe("completed");
      expect(final.result).toBeDefined();
      const result = final.result!;

      const security = result.categories.find((c) => c.category === "security");
      expect(security).toBeDefined();
      expect(security!.status).toBe("scored");
      expect(security!.score).not.toBeNull();
      expect(security!.score as number).toBeLessThan(100);
      expect(security!.findings.length).toBeGreaterThan(0);

      const ruleIds = security!.findings.map((f) => f.ruleId);
      for (const expectedRuleId of SEMGREP_RULE_IDS) {
        expect(ruleIds).toContain(expectedRuleId);
      }

      // At least one finding NOT among the 3 Semgrep rule ids above — i.e.
      // the real OSV-Scanner pass over package-lock.json's vulnerable
      // lodash@4.17.15 also produced a real finding.
      const osvFindings = security!.findings.filter((f) => !SEMGREP_RULE_IDS.includes(f.ruleId));
      expect(osvFindings.length).toBeGreaterThan(0);
    },
    180_000,
  );
});
