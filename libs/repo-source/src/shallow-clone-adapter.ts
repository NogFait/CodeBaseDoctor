import Docker from "dockerode";
import {
  CloneTimeoutError,
  RepoNotAccessibleError,
  RepoTooLargeError,
  TooManyFilesError,
  MAX_READABLE_FILE_BYTES,
  FileTooLargeError,
} from "@cbd/analysis";
import type {
  IngestionLimits,
  LanguageShare,
  RepoContext,
  RepoFile,
  RepoMetadata,
  RepoRef,
  RepoSourcePort,
  RepoWorkspace,
} from "@cbd/analysis";
import { parseGithubRepoUrl } from "./repo-url";
import {
  buildCloneArgs,
  buildLsRemoteArgs,
  buildLsTreeCountArgs,
  classifyCloneFailure,
  classifyLsRemoteFailure,
} from "./git-commands";
import { buildDuArgs, parseDuOutputKb } from "./disk-usage";
import { demuxDockerLog } from "./docker-log";

/** The volume's mount point inside every container. */
const MOUNT_DIR = "/work";
/** Where the clone actually lands — a SUBDIRECTORY of the mount, not the
 * mount root. See class doc, deviation 4: on this Docker install, a fresh
 * named volume's mount-root directory silently resets its own ownership
 * and permission bits to root:root/755 on every new container that mounts
 * it, even after a previous container chown'd/chmod'd it — verified
 * directly, several different ways. A chowned SUBDIRECTORY beneath that
 * root does NOT reset and stays writable by the unprivileged container
 * user across container boundaries, so every real read/write happens
 * inside `${MOUNT_DIR}/repo` instead of at the mount root itself. */
const REPO_DIR = `${MOUNT_DIR}/repo`;

/** Extension -> language map. Mirrors FixtureRepoSource's convention (Phase
 * 2) so a fixture-driven unit test and a real ingestion produce the same
 * shape of languageMix. See apply-progress deviation #3. */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rb": "Ruby",
  ".java": "Java",
  ".rs": "Rust",
};
const DOMINANT_LANGUAGE_SHARE_THRESHOLD = 0.4;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ShallowCloneAdapterOptions {
  /** Injectable for tests; defaults to a Dockerode instance using the local socket. */
  docker?: Docker;
  fetcherImage?: string;
  scannerImage?: string;
}

/**
 * RepoSourcePort implementation — the two-container fetcher/scanner
 * pipeline. See design: "Ephemeral Scan Container Design".
 *
 * Deviations from the design's literal wording, made necessary by real
 * constraints discovered while implementing (all documented in
 * apply-progress):
 *  1. Volume size cap is a POST-CLONE `du -sk` measurement (see
 *     disk-usage.ts), not a live `--storage-opt size=` quota. Two real,
 *     independently-verified constraints of this sandbox rule out design
 *     step 1's literal mechanism: (a) the Docker storage driver is
 *     overlayfs, which doesn't support ext4/xfs per-volume quotas; (b) a
 *     tmpfs-backed *named* volume (the first substitute tried) does NOT
 *     persist data across separate sequential `docker run` invocations
 *     sharing that volume — confirmed directly: a clone into a
 *     tmpfs-optioned volume succeeds, then a second container mounting the
 *     SAME volume sees an empty directory. Since materialize() must share
 *     one clone's content across 3-4 separate containers (fetcher clone ->
 *     fetcher count-gate -> scanner -> optional reader), the volume must be
 *     a real persistent local-driver volume, which in turn can't carry a
 *     kernel quota here either. The `du` check runs strictly after the
 *     (already depth-1-bounded) clone container has exited — no live
 *     download to race, unlike the "polling du during clone" alternative
 *     decision #3 explicitly rejects.
 *  2. head()'s network call and the file-count gate both run as their own
 *     short-lived `cbd-fetcher` container invocations (entrypoint is
 *     already `git`) rather than ever shelling out from the worker host —
 *     keeps 100% of git networking behind the container boundary design
 *     decision #1 establishes, even for read-only metadata calls.
 *  3. RepoContext.readFile() cannot read the docker-managed volume
 *     directly from the worker host process in this environment (the
 *     volume's mountpoint under /var/lib/docker/volumes is root-owned,
 *     confirmed by direct test) — it runs a tiny `cat`-via-cbd-scanner
 *     container per call instead (image already has no shell tooling
 *     beyond what's needed, mounted `:ro`, `--network none`, same as the
 *     real scan). Slower per call than a filesystem read but never breaks
 *     the "worker never touches repo bytes directly" property.
 *  4. The clone target is `${MOUNT_DIR}/repo` (a subdirectory of the
 *     volume mount), not the mount root itself. A fresh named volume's
 *     mount-ROOT directory resets its own ownership/permission bits back
 *     to root:root/755 on every new container that mounts it — even right
 *     after a previous container explicitly chowned or chmod 777'd it —
 *     confirmed directly by chowning the root in one container and
 *     `stat`-ing it as root in a fresh second container (came back
 *     root:root every time). A chowned SUBDIRECTORY beneath the root does
 *     NOT reset the same way and stays writable by the unprivileged
 *     65534:65534 user across container boundaries — also confirmed
 *     directly. `prepareVolumeOwnership()` therefore creates and chowns
 *     `repo/` before anything else touches the volume.
 */
export class ShallowCloneAdapter implements RepoSourcePort {
  private readonly docker: Docker;
  private readonly fetcherImage: string;
  private readonly scannerImage: string;

  constructor(options: ShallowCloneAdapterOptions = {}) {
    this.docker = options.docker ?? new Docker();
    this.fetcherImage = options.fetcherImage ?? "cbd-fetcher:local";
    this.scannerImage = options.scannerImage ?? "cbd-scanner:local";
  }

  async resolve(url: string): Promise<RepoRef> {
    return parseGithubRepoUrl(url);
  }

  async head(ref: RepoRef): Promise<RepoMetadata> {
    const result = await this.runFetcher({
      cmd: buildLsRemoteArgs(ref.url),
      network: "bridge",
    });

    if (result.exitCode !== 0) {
      const kind = classifyLsRemoteFailure(result.stderr);
      if (kind === "not-accessible") {
        throw new RepoNotAccessibleError(ref.url, "not-found");
      }
      throw new RepoNotAccessibleError(ref.url, "not-found");
    }

    const headSha = result.stdout.split(/\s+/)[0];
    if (!headSha || headSha.length !== 40) {
      throw new RepoNotAccessibleError(ref.url, "not-found");
    }

    // sizeKb is unknown without a GitHub REST call (deliberately not made
    // here — see class doc). Gate 1 of the "Monorepo ceiling" three-gate
    // design (head().sizeKb > 500_000 -> reject with no clone) is skipped;
    // gates 2 (volume quota) and 3 (file-count) still fully enforce the cap.
    return { defaultBranch: "HEAD", headSha, sizeKb: 0, visibility: "public" };
  }

  async materialize(ref: RepoRef, sha: string, limits: IngestionLimits): Promise<RepoWorkspace> {
    const jobId = `cbd-job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const volumeName = jobId;

    await this.docker.createVolume({ Name: volumeName, Driver: "local" });

    let disposed = false;
    const dispose = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      try {
        await this.docker.getVolume(volumeName).remove({ force: true });
      } catch {
        // best-effort — a reaper handles anything left behind, per design step 5
      }
    };

    try {
      // A freshly `docker volume create`d directory is root-owned; every
      // container in this pipeline runs as the unprivileged 65534:65534
      // per design's runtime flags table, so it cannot write into it
      // as-is. One root-run, throwaway container fixes ownership before
      // anything untrusted touches the volume.
      await this.prepareVolumeOwnership(volumeName);

      const cloneResult = await this.runFetcher({
        cmd: buildCloneArgs(ref.url, REPO_DIR),
        network: "bridge",
        volume: { name: volumeName, mountPath: MOUNT_DIR, readOnly: false },
        timeoutMs: limits.cloneTimeoutMs,
      });

      if (cloneResult.timedOut) {
        throw new CloneTimeoutError(limits.cloneTimeoutMs);
      }
      if (cloneResult.exitCode !== 0) {
        const kind = classifyCloneFailure(cloneResult.stderr);
        if (kind === "too-large") {
          throw new RepoTooLargeError({ maxBytes: limits.maxVolumeBytes, maxFiles: limits.maxFiles }, {});
        }
        if (kind === "not-accessible") {
          throw new RepoNotAccessibleError(ref.url, "not-found");
        }
        throw new Error(`cbd-fetcher clone failed (exit ${cloneResult.exitCode}): ${cloneResult.stderr}`);
      }

      const duResult = await this.runFetcher({
        cmd: buildDuArgs(REPO_DIR),
        entrypoint: ["du"],
        network: "none",
        volume: { name: volumeName, mountPath: MOUNT_DIR, readOnly: false },
      });
      if (duResult.exitCode !== 0) {
        throw new Error(`cbd-fetcher disk-usage gate failed: ${duResult.stderr}`);
      }
      const usedKb = parseDuOutputKb(duResult.stdout);
      const maxKb = Math.ceil(limits.maxVolumeBytes / 1024);
      if (usedKb > maxKb) {
        throw new RepoTooLargeError(
          { maxBytes: limits.maxVolumeBytes, maxFiles: limits.maxFiles },
          { sizeKb: usedKb },
        );
      }

      const countResult = await this.runFetcher({
        cmd: buildLsTreeCountArgs(REPO_DIR),
        network: "none",
        volume: { name: volumeName, mountPath: MOUNT_DIR, readOnly: false },
      });
      if (countResult.exitCode !== 0) {
        throw new Error(`cbd-fetcher file-count gate failed: ${countResult.stderr}`);
      }
      const fileCount = countResult.stdout.split("\n").filter((l) => l.trim().length > 0).length;
      if (fileCount > limits.maxFiles) {
        throw new TooManyFilesError(limits.maxFiles, fileCount);
      }

      const indexResult = await this.runScanner({ volumeName });
      if (indexResult.exitCode !== 0) {
        throw new Error(`cbd-scanner indexing failed: ${indexResult.stderr}`);
      }

      const context = this.buildRepoContext(ref.url, sha, volumeName, indexResult.stdout);
      return { context, dispose };
    } catch (err) {
      await dispose();
      throw err;
    }
  }

  // ---- internal: RepoContext built from the scanner's JSON blob --------

  private buildRepoContext(repoUrl: string, commitSha: string, volumeName: string, indexJson: string): RepoContext {
    const parsed = JSON.parse(indexJson) as {
      files: { path: string; sizeBytes: number; loc?: number }[];
    };

    const files: RepoFile[] = parsed.files.map((f) => ({
      path: f.path,
      sizeBytes: f.sizeBytes,
      loc: f.loc ?? 0,
      language: detectLanguage(f.path),
    }));

    // LOC/languageMix computed the same way FixtureRepoSource does (recognized
    // languages only, config/doc files excluded from the denominator — see
    // apply-progress deviation #3).
    const locByLanguage = new Map<string, number>();
    for (const file of files) {
      if (file.language === null) continue;
      locByLanguage.set(file.language, (locByLanguage.get(file.language) ?? 0) + file.loc);
    }
    const totalLoc = [...locByLanguage.values()].reduce((sum, n) => sum + n, 0);
    const languageMix: LanguageShare[] = [...locByLanguage.entries()]
      .map(([language, loc]) => ({ language, loc, share: totalLoc === 0 ? 0 : loc / totalLoc }))
      .sort((a, b) => b.loc - a.loc);
    const dominantLanguage =
      languageMix.length > 0 && languageMix[0].share >= DOMINANT_LANGUAGE_SHARE_THRESHOLD
        ? languageMix[0].language
        : null;

    const readFile = async (filePath: string): Promise<string> => {
      const meta = files.find((f) => f.path === filePath);
      if (!meta) {
        throw new Error(`ShallowCloneAdapter: unknown file "${filePath}"`);
      }
      if (meta.sizeBytes > MAX_READABLE_FILE_BYTES) {
        throw new FileTooLargeError(filePath, meta.sizeBytes, MAX_READABLE_FILE_BYTES);
      }
      const result = await this.runReader(volumeName, filePath);
      if (result.exitCode !== 0) {
        throw new Error(`ShallowCloneAdapter: failed to read "${filePath}": ${result.stderr}`);
      }
      return result.stdout;
    };

    const glob = (pattern: string): readonly string[] => {
      if (pattern.startsWith("**/*")) {
        const suffix = pattern.slice(4);
        return files.map((f) => f.path).filter((p) => p.endsWith(suffix));
      }
      return files.map((f) => f.path).filter((p) => p === pattern);
    };

    return {
      repoUrl,
      commitSha,
      rootPath: REPO_DIR,
      files,
      dominantLanguage,
      languageMix,
      totalLoc,
      readFile,
      glob,
    };
  }

  // ---- internal: container orchestration --------------------------------

  /** Root-run, throwaway container that creates `repo/` inside the fresh
   * volume and `chown`s THAT (not the mount root — see class doc deviation
   * 4) to 65534:65534, before any git/scan container (all unprivileged)
   * touches it. Uses the fetcher image (already pulled) with entrypoint
   * overridden — this is the ONLY container in the whole pipeline that
   * runs as root, and it never touches network or repo content, only
   * volume-local directory setup.
   *
   * Deliberately does NOT set `CapDrop: ["ALL"]` here (unlike every other
   * container in this file) — chown requires CAP_CHOWN, which Linux checks
   * independently of UID even for UID 0 once capabilities are involved.
   * First implementation dropped all caps AND ignored this container's
   * exit code, so the chown silently no-op'd (EPERM) and every downstream
   * step failed with "Permission denied" without an obvious cause —
   * verified directly by running the same sequence outside Vitest. Now the
   * exit code is checked and surfaced loudly instead. */
  private async prepareVolumeOwnership(volumeName: string): Promise<void> {
    const container = await this.docker.createContainer({
      Image: this.fetcherImage,
      Entrypoint: ["sh"],
      Cmd: ["-c", `mkdir -p ${REPO_DIR} && chown 65534:65534 ${REPO_DIR}`],
      HostConfig: {
        Binds: [`${volumeName}:${MOUNT_DIR}`],
        NetworkMode: "none",
      },
      User: "0:0",
    });
    try {
      await container.start();
      const { StatusCode } = (await container.wait()) as { StatusCode: number };
      if (StatusCode !== 0) {
        const logBuffer = (await container.logs({ stdout: true, stderr: true, follow: false })) as unknown as Buffer;
        const { stderr } = demuxDockerLog(Buffer.isBuffer(logBuffer) ? logBuffer : Buffer.from(logBuffer));
        throw new Error(`ShallowCloneAdapter: failed to prepare volume ownership: ${stderr}`);
      }
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  private async runFetcher(opts: {
    cmd: string[];
    entrypoint?: string[];
    network: "bridge" | "none";
    volume?: { name: string; mountPath: string; readOnly: boolean };
    timeoutMs?: number;
  }): Promise<RunResult & { timedOut?: boolean }> {
    return this.runContainer({
      image: this.fetcherImage,
      cmd: opts.cmd,
      entrypoint: opts.entrypoint,
      network: opts.network,
      volume: opts.volume,
      timeoutMs: opts.timeoutMs,
      memory: 512 * 1024 * 1024,
      pidsLimit: 128,
      nanoCpus: 1_000_000_000,
      tmpfsSizeOpt: "size=64m",
    });
  }

  private async runScanner(opts: { volumeName: string }): Promise<RunResult> {
    return this.runContainer({
      image: this.scannerImage,
      cmd: [REPO_DIR],
      network: "none",
      volume: { name: opts.volumeName, mountPath: MOUNT_DIR, readOnly: true },
      memory: 2 * 1024 * 1024 * 1024,
      pidsLimit: 512,
      nanoCpus: 2_000_000_000,
      tmpfsSizeOpt: "size=256m",
    });
  }

  /** One file read = one short-lived container using `cat`, overriding the
   * image's baked-in entrypoint at container-creation time (dockerode
   * supports this without touching the image). See class doc, deviation 3. */
  private async runReader(volumeName: string, filePath: string): Promise<RunResult> {
    return this.runContainer({
      image: this.scannerImage,
      entrypoint: ["cat"],
      cmd: [`${REPO_DIR}/${filePath}`],
      network: "none",
      volume: { name: volumeName, mountPath: MOUNT_DIR, readOnly: true },
      memory: 256 * 1024 * 1024,
      pidsLimit: 32,
      nanoCpus: 500_000_000,
      tmpfsSizeOpt: "size=16m",
    });
  }

  private async runContainer(opts: {
    image: string;
    cmd: string[];
    entrypoint?: string[];
    network: "bridge" | "none";
    volume?: { name: string; mountPath: string; readOnly: boolean };
    timeoutMs?: number;
    memory: number;
    pidsLimit: number;
    nanoCpus: number;
    tmpfsSizeOpt: string;
  }): Promise<RunResult & { timedOut?: boolean }> {
    const binds = opts.volume ? [`${opts.volume.name}:${opts.volume.mountPath}${opts.volume.readOnly ? ":ro" : ""}`] : [];

    const container = await this.docker.createContainer({
      Image: opts.image,
      Cmd: opts.cmd,
      Entrypoint: opts.entrypoint,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      HostConfig: {
        Binds: binds,
        NetworkMode: opts.network,
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": opts.tmpfsSizeOpt },
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        Memory: opts.memory,
        PidsLimit: opts.pidsLimit,
        NanoCpus: opts.nanoCpus,
      },
      User: "65534:65534",
    });

    try {
      await container.start();

      const waitPromise = container.wait();
      let timedOut = false;
      const result = opts.timeoutMs
        ? await Promise.race([
            waitPromise.then((w: { StatusCode: number }) => w),
            new Promise<null>((resolve) =>
              setTimeout(() => {
                timedOut = true;
                resolve(null);
              }, opts.timeoutMs),
            ),
          ])
        : await waitPromise;

      if (timedOut) {
        await container.kill().catch(() => undefined);
        return { exitCode: -1, stdout: "", stderr: "", timedOut: true };
      }

      const logBuffer = (await container.logs({ stdout: true, stderr: true, follow: false })) as unknown as Buffer;
      const { stdout, stderr } = demuxDockerLog(Buffer.isBuffer(logBuffer) ? logBuffer : Buffer.from(logBuffer));

      return { exitCode: (result as { StatusCode: number }).StatusCode, stdout, stderr };
    } finally {
      await container.remove({ force: true }).catch(() => undefined);
    }
  }
}

function detectLanguage(relPath: string): string | null {
  const ext = relPath.slice(relPath.lastIndexOf("."));
  return LANGUAGE_BY_EXTENSION[ext] ?? null;
}
