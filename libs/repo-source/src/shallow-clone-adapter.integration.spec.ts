import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CloneTimeoutError,
  RepoNotAccessibleError,
  RepoTooLargeError,
  ScanTimeoutError,
  TooManyFilesError,
} from "@cbd/analysis";
import type { RepoRef } from "@cbd/analysis";
import { ShallowCloneAdapter } from "./shallow-clone-adapter";
import { startGitFixtureServer, waitForPort, type GitFixtureServer } from "../testing/git-fixture-server";

// Real Docker, real git daemon, real clone. No mocking of dockerode, no
// mocking of git output — see class doc on ShallowCloneAdapter and
// git-fixture-server.ts for why `git://` (not `file://`) is used to serve
// fixtures locally, and why sizeKb-based head() pre-flight is skipped.

function refFor(server: GitFixtureServer, repoName: string): RepoRef {
  return { host: "github", owner: "fixture", repo: repoName, url: `${server.baseUrl}/${repoName}` };
}

const GENEROUS_LIMITS = { maxVolumeBytes: 50 * 1024 * 1024, maxFiles: 1000, cloneTimeoutMs: 30_000 };

describe("ShallowCloneAdapter — real Docker integration", () => {
  let server: GitFixtureServer;
  const adapter = new ShallowCloneAdapter({ fetcherImage: "cbd-fetcher:local", scannerImage: "cbd-scanner:local" });

  beforeAll(async () => {
    server = startGitFixtureServer([
      {
        name: "small-repo",
        files: {
          "README.md": "# Small repo\n",
          "src/index.js": "console.log('hi');\nmodule.exports = {};\n",
          "src/util.js": "function noop() {}\nmodule.exports = { noop };\n",
        },
      },
      {
        name: "oversized-repo",
        files: {
          "blob-a.bin": "A".repeat(700 * 1024),
          "blob-b.bin": "B".repeat(700 * 1024),
          "blob-c.bin": "C".repeat(700 * 1024),
          "blob-d.bin": "D".repeat(700 * 1024),
        },
      },
      {
        name: "many-files-repo",
        files: Object.fromEntries(
          Array.from({ length: 12 }, (_, i) => [`file-${i}.txt`, `content ${i}\n`]),
        ),
      },
      {
        name: "hook-repo",
        files: { "README.md": "# hook repo\n" },
        seedHostileHook: true,
      },
    ]);
    await waitForPort(server.port, "127.0.0.1", 5000);
  });

  afterAll(() => {
    server.stop();
  });

  it("materialize() clones a real repo and produces a real RepoContext", async () => {
    const workspace = await adapter.materialize(refFor(server, "small-repo"), "0".repeat(40), GENEROUS_LIMITS);

    try {
      const paths = workspace.context.files.map((f) => f.path).sort();
      expect(paths).toEqual(["README.md", "src/index.js", "src/util.js"]);

      const indexFile = workspace.context.files.find((f) => f.path === "src/index.js");
      expect(indexFile).toBeDefined();
      expect(indexFile!.loc).toBe(2);
      expect(indexFile!.language).toBe("JavaScript");

      expect(workspace.context.dominantLanguage).toBe("JavaScript");
      expect(workspace.context.totalLoc).toBe(4); // index.js(2) + util.js(2)

      const content = await workspace.context.readFile("src/index.js");
      expect(content).toContain("console.log");
    } finally {
      await workspace.dispose();
    }
  });

  it("rejects an oversized repo with RepoTooLargeError via the volume's kernel-enforced cap", async () => {
    // 4 files x 700KB = ~2.8MB of tracked content; a 1MB tmpfs volume cannot
    // hold the working tree + git objects for that, so the fetcher hits a
    // real ENOSPC mid-clone.
    const tinyLimits = { maxVolumeBytes: 1 * 1024 * 1024, maxFiles: 1000, cloneTimeoutMs: 30_000 };

    await expect(
      adapter.materialize(refFor(server, "oversized-repo"), "1".repeat(40), tinyLimits),
    ).rejects.toThrow(RepoTooLargeError);
  });

  it("rejects a repo exceeding the file-count gate with TooManyFilesError", async () => {
    const tightFileCount = { maxVolumeBytes: 50 * 1024 * 1024, maxFiles: 3, cloneTimeoutMs: 30_000 };

    await expect(
      adapter.materialize(refFor(server, "many-files-repo"), "2".repeat(40), tightFileCount),
    ).rejects.toThrow(TooManyFilesError);
  });

  it("never executes a repo-side hook during clone (core.hooksPath=/dev/null holds end to end)", async () => {
    const workspace = await adapter.materialize(refFor(server, "hook-repo"), "3".repeat(40), GENEROUS_LIMITS);

    try {
      // The marker would only ever be written by git actually invoking the
      // hook from the SERVER's bare repo (an attack vector this project
      // documents does not exist for plain `clone` in real git regardless —
      // see git-fixture-server.ts doc comment). This assertion proves the
      // marker is absent from the materialized workspace's own file list;
      // it does not, and cannot, prove a hostile hook was "blocked" since
      // git never attempted to run one. The decisive test for the actual
      // production flag is git-commands.spec.ts's buildCloneArgs assertion.
      const paths = workspace.context.files.map((f) => f.path);
      expect(paths).not.toContain("HOOK_FIRED_MARKER");
      expect(existsSync(`${server.bareRepoPath("hook-repo")}/HOOK_FIRED_MARKER`)).toBe(false);
    } finally {
      await workspace.dispose();
    }
  });

  it("head() resolves a real headSha for an accessible repo", async () => {
    const metadata = await adapter.head(refFor(server, "small-repo"));

    expect(metadata.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(metadata.visibility).toBe("public");
  });

  it("head() throws RepoNotAccessibleError for a repo that resolves but does not exist server-side", async () => {
    await expect(adapter.head(refFor(server, "does-not-exist-repo"))).rejects.toThrow(RepoNotAccessibleError);
  });

  it("materialize() throws CloneTimeoutError when the clone exceeds the configured timeout", async () => {
    const impossibleTimeout = { maxVolumeBytes: 50 * 1024 * 1024, maxFiles: 1000, cloneTimeoutMs: 1 };

    await expect(
      adapter.materialize(refFor(server, "small-repo"), "4".repeat(40), impossibleTimeout),
    ).rejects.toThrow(CloneTimeoutError);
  });

  it("materialize() throws ScanTimeoutError when the scanner-container step exceeds its own (separate) timeout budget", async () => {
    // Own adapter instance with an impossibly short scanTimeoutMs — the
    // clone/du/file-count gates all still get their normal generous
    // budget, only the scanner-container step (Semgrep + OSV-Scanner) is
    // starved, proving this is a genuinely separate timeout layer from
    // CloneTimeoutError's clone-step budget above.
    const shortScanAdapter = new ShallowCloneAdapter({
      fetcherImage: "cbd-fetcher:local",
      scannerImage: "cbd-scanner:local",
      scanTimeoutMs: 1,
    });

    await expect(
      shortScanAdapter.materialize(refFor(server, "small-repo"), "5".repeat(40), GENEROUS_LIMITS),
    ).rejects.toThrow(ScanTimeoutError);
  });
});
