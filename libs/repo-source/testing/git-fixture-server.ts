import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as net from "node:net";

/**
 * Serves committed bare-repo fixtures over `git://` (via `git daemon`) so
 * ShallowCloneAdapter's integration tests exercise a REAL clone, from a
 * REAL Docker container, over a REAL network transport — without ever
 * touching github.com.
 *
 * Why not `file://`, as originally suggested: the production clone command
 * (git-commands.ts: buildCloneArgs) hardcodes `-c protocol.file.allow=never`
 * per design step 2, which disables git's file transport entirely —
 * including plain local-path clones, since those also go through the file
 * transport internally. Weakening that flag just for tests would mean the
 * integration test no longer exercises the real production command, which
 * defeats the point. `git://` isn't restricted by that flag, so serving
 * fixtures via `git daemon` on a loopback/bridge-reachable port lets the
 * exact same production invocation run end-to-end. See apply-progress for
 * the full reasoning.
 *
 * The daemon binds 0.0.0.0 so the `cbd-fetcher` container (network mode
 * `bridge`) can reach it via the Docker bridge gateway IP.
 */
export interface GitFixtureServer {
  /** e.g. "git://172.17.0.1:9418" — pair with `/<repoName>` for a clone URL. */
  baseUrl: string;
  /** The allocated TCP port, for readiness polling from the host side. */
  port: number;
  /** Absolute path to the bare repo's directory, for out-of-band inspection. */
  bareRepoPath(repoName: string): string;
  stop(): void;
}

function findFreePort(): number {
  const srv = net.createServer();
  srv.listen(0);
  const address = srv.address();
  if (address === null || typeof address === "string") {
    throw new Error("git-fixture-server: could not allocate a free port");
  }
  const port = address.port;
  srv.close();
  return port;
}

function run(cmd: string, args: string[], cwd?: string): void {
  const result = spawnSync(cmd, args, { cwd, stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(
      `git-fixture-server: "${cmd} ${args.join(" ")}" failed (exit ${result.status}): ${result.stderr?.toString()}`,
    );
  }
}

export interface FixtureRepoSpec {
  name: string;
  files: Record<string, string>;
  /** Optional: seed a `post-checkout` hook in the SERVER-side bare repo's own
   * hooks dir. Documented caveat (see apply-progress): git never transfers
   * `.git/hooks` content to the client over `clone`, with or without
   * `core.hooksPath=/dev/null` — so this cannot prove "a malicious remote
   * hook was blocked". It DOES prove the marker never appears in the cloned
   * working tree, which is still a real (if narrower) regression guard,
   * and it exists specifically because the orchestrator's task asked for
   * it. The decisive hooks-disabled assertion is the pure unit test on
   * `buildCloneArgs` in git-commands.spec.ts, which asserts the exact flag
   * is always present in the command sent to the container.
   */
  seedHostileHook?: boolean;
}

/**
 * Builds N bare repo fixtures under a tmp base-path and serves them all via
 * one `git daemon --export-all`. Returns the server handle plus a `stop()`
 * that kills the daemon and leaves the tmp dir for the OS to reap.
 */
export function startGitFixtureServer(specs: FixtureRepoSpec[]): GitFixtureServer {
  const basePath = mkdtempSync(path.join(tmpdir(), "cbd-git-fixtures-"));

  for (const spec of specs) {
    const bareDir = path.join(basePath, spec.name);
    const workDir = mkdtempSync(path.join(tmpdir(), `cbd-fixture-work-${spec.name}-`));

    run("git", ["init", "--bare", "-q", bareDir]);
    run("git", ["init", "-q", workDir], undefined);
    run("git", ["-C", workDir, "init", "-q"]);
    run("git", ["-C", workDir, "config", "user.email", "fixture@cbd.local"]);
    run("git", ["-C", workDir, "config", "user.name", "cbd fixture"]);

    for (const [relPath, content] of Object.entries(spec.files)) {
      const abs = path.join(workDir, relPath);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    }
    run("git", ["-C", workDir, "add", "-A"]);
    run("git", ["-C", workDir, "commit", "-q", "-m", "fixture commit"]);
    run("git", ["-C", workDir, "branch", "-M", "main"]);
    run("git", ["-C", workDir, "remote", "add", "origin", bareDir]);
    run("git", ["-C", workDir, "push", "-q", "origin", "main"]);
    run("git", ["-C", bareDir, "symbolic-ref", "HEAD", "refs/heads/main"]);

    if (spec.seedHostileHook) {
      const markerPath = path.join(bareDir, "HOOK_FIRED_MARKER");
      const hookPath = path.join(bareDir, "hooks", "post-checkout");
      writeFileSync(hookPath, `#!/bin/sh\necho fired > ${markerPath}\n`, "utf8");
      chmodSync(hookPath, 0o755);
    }
  }

  const port = findFreePort();
  const daemon: ChildProcess = spawn(
    "git",
    ["daemon", "--reuseaddr", `--base-path=${basePath}`, "--export-all", `--port=${port}`, "--listen=0.0.0.0"],
    { stdio: "ignore" },
  );

  return {
    baseUrl: `git://172.17.0.1:${port}`,
    port,
    bareRepoPath: (repoName: string) => path.join(basePath, repoName),
    stop: () => {
      daemon.kill("SIGKILL");
    },
  };
}

/** Blocks (busy-poll) until the daemon accepts TCP connections, or throws. */
export async function waitForPort(port: number, host = "127.0.0.1", timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ port, host }, () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.setTimeout(200, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`git-fixture-server: daemon did not open port ${port} within ${timeoutMs}ms`);
}
