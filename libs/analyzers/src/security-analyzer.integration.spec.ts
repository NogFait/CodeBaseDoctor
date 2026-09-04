import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RepoRef } from "@cbd/analysis";
import { ShallowCloneAdapter } from "@cbd/repo-source";
import { startGitFixtureServer, waitForPort, type GitFixtureServer } from "@cbd/repo-source/testing/git-fixture-server";
import { SecurityAnalyzer } from "./security-analyzer";
import { DefaultScanOutputReader } from "./scan-output";

// End-to-end proof of task 3.2.8's wiring: real Docker containers (fetcher +
// scanner), a real materialize() clone, a REAL Semgrep + OSV-Scanner
// invocation inside the network-isolated cbd-scanner container (offline
// local rules / baked vulnerability DBs — see cbd-scanner.Dockerfile), and
// SecurityAnalyzer reading the result through the REAL DefaultScanOutputReader
// (no mocks anywhere in this file). This is the test that actually proves
// the seam works end-to-end, not just that the indexer script runs in
// isolation — see shallow-clone-adapter.integration.spec.ts for the
// equivalent pattern this file reuses (same git-fixture-server
// infrastructure, not reinvented).

function refFor(server: GitFixtureServer, repoName: string): RepoRef {
  return { host: "github", owner: "fixture", repo: repoName, url: `${server.baseUrl}/${repoName}` };
}

const GENEROUS_LIMITS = { maxVolumeBytes: 50 * 1024 * 1024, maxFiles: 1000, cloneTimeoutMs: 30_000 };

describe("SecurityAnalyzer — real Docker + real Semgrep/OSV-Scanner integration", () => {
  let server: GitFixtureServer;
  const adapter = new ShallowCloneAdapter({ fetcherImage: "cbd-fetcher:local", scannerImage: "cbd-scanner:local" });

  beforeAll(async () => {
    server = startGitFixtureServer([
      {
        // Known Semgrep-detectable patterns (matches this project's own
        // vendored rules — see apps/worker/docker/semgrep-rules/security.yaml)
        // PLUS a package-lock.json pinning a real, known-vulnerable lodash
        // version, so both scanners produce real findings in one fixture.
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
      {
        // No secrets, no eval/exec, no string-concatenated SQL, no
        // known-vulnerable dependency manifest at all — nothing for either
        // scanner to flag.
        name: "clean-repo",
        files: {
          "app.ts": [
            "export function add(a: number, b: number): number {",
            "  return a + b;",
            "}",
            "",
          ].join("\n"),
        },
      },
    ]);
    await waitForPort(server.port, "127.0.0.1", 5000);
  });

  afterAll(() => {
    server.stop();
  });

  it("scores a repo with real Semgrep-detectable issues meaningfully below 100", async () => {
    const workspace = await adapter.materialize(refFor(server, "dirty-repo"), "0".repeat(40), GENEROUS_LIMITS);

    try {
      const analyzer = new SecurityAnalyzer(new DefaultScanOutputReader());
      const result = await analyzer.analyze(workspace.context, new AbortController().signal);

      expect(result.status).toBe("scored");
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.score).not.toBeNull();
      expect(result.score as number).toBeLessThan(100);

      const semgrepFindings = result.findings.filter((f) =>
        ["hardcoded-secret", "dangerous-eval", "sql-string-concatenation"].includes(f.ruleId),
      );
      expect(semgrepFindings.length).toBeGreaterThan(0);
    } finally {
      await workspace.dispose();
    }
  });

  it("scores a clean repo with no findings at (or near) 100", async () => {
    const workspace = await adapter.materialize(refFor(server, "clean-repo"), "1".repeat(40), GENEROUS_LIMITS);

    try {
      const analyzer = new SecurityAnalyzer(new DefaultScanOutputReader());
      const result = await analyzer.analyze(workspace.context, new AbortController().signal);

      expect(result.status).toBe("scored");
      expect(result.findings).toHaveLength(0);
      expect(result.score).toBe(100);
    } finally {
      await workspace.dispose();
    }
  });
});
