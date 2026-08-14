// Pure git argv builders and stderr classifiers for ShallowCloneAdapter.
// Kept side-effect-free and dockerode-free on purpose (Extract-Before-Mock):
// the exact invocation shape design mandates (hooks disabled, file protocol
// disabled, blob-size filter) is the highest-value thing to unit-test, and a
// pure function lets that assertion run in milliseconds with zero Docker.
// See design: "Ephemeral Scan Container Design" step 2-3.

export type GitFailureKind = "too-large" | "not-accessible" | "other";

/**
 * Exact clone invocation per design step 2. `core.hooksPath=/dev/null`
 * disables any hook regardless of source (defense-in-depth, not just
 * repo-supplied hooks — see apply-progress for why this can't be proven via
 * a "malicious remote hook" integration test: git never transfers
 * .git/hooks content over clone in the first place).
 * `protocol.file.allow=never` blocks the file transport entirely, so this
 * command cannot be pointed at a local filesystem path — only network
 * transports (https, git, ssh) are usable, which is also why the
 * integration tests serve fixtures over `git://` via `git daemon` rather
 * than `file://`.
 */
export function buildCloneArgs(url: string, destDir: string): string[] {
  return [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "protocol.file.allow=never",
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--filter=blob:limit=1m",
    "--no-tags",
    url,
    destDir,
  ];
}

/** head()'s network call — ref metadata only, never touches repo bytes. */
export function buildLsRemoteArgs(url: string): string[] {
  return ["-c", "protocol.file.allow=never", "ls-remote", "--exit-code", url, "HEAD"];
}

/** File-count gate per design step 3 — metadata over an already-shallow
 * tree. Uses `-C <dir>` rather than relying on the container's WORKDIR so
 * it can target a chowned subdirectory of the mount (see
 * shallow-clone-adapter.ts class doc, deviation 4, for why the clone lands
 * in a subdirectory rather than at the volume's mount root). */
export function buildLsTreeCountArgs(dir: string): string[] {
  return ["-C", dir, "ls-tree", "-r", "--name-only", "HEAD"];
}

const TOO_LARGE_PATTERNS = [/no space left on device/i, /enospc/i];
const NOT_ACCESSIBLE_PATTERNS = [
  /could not read (username|from remote repository)/i,
  /repository not found/i,
  /authentication failed/i,
  /unable to access/i,
  /access denied/i,
  /fatal: repository .* does not exist/i,
];
const CONNECTION_PATTERNS = [/connection refused/i, /unable to connect/i, /could not resolve host/i];

function classify(stderr: string, patterns: RegExp[], kind: GitFailureKind): GitFailureKind | null {
  return patterns.some((p) => p.test(stderr)) ? kind : null;
}

/** Maps `git clone` stderr to the RepoSourcePort error family it implies. */
export function classifyCloneFailure(stderr: string): GitFailureKind {
  return (
    classify(stderr, TOO_LARGE_PATTERNS, "too-large") ??
    classify(stderr, NOT_ACCESSIBLE_PATTERNS, "not-accessible") ??
    "other"
  );
}

/** Maps `git ls-remote` stderr (head()) to the RepoSourcePort error family it implies. */
export function classifyLsRemoteFailure(stderr: string): GitFailureKind {
  return (
    classify(stderr, NOT_ACCESSIBLE_PATTERNS, "not-accessible") ??
    classify(stderr, CONNECTION_PATTERNS, "not-accessible") ??
    "other"
  );
}

/**
 * The local Docker volume driver in this sandbox (`overlayfs` backing store)
 * does not support ext4-style `--storage-opt size=` quotas the way design's
 * step 1 literally specifies — verified directly (see apply-progress). This
 * project maps the same byte budget onto a tmpfs-backed local volume
 * (`--opt type=tmpfs --opt device=tmpfs --opt o=size=<N>m`) instead, which
 * the kernel enforces with a real ENOSPC on overflow, preserving the
 * property decision #3 actually cares about: enforcement by the kernel, not
 * by an application-level byte counter.
 */
export function bytesToTmpfsSizeOpt(bytes: number): string {
  const megabytes = Math.max(1, Math.ceil(bytes / (1024 * 1024)));
  return `${megabytes}m`;
}
