// Post-clone volume size gate. See shallow-clone-adapter.ts class doc for
// why this exists instead of design step 1's literal `--storage-opt size=`:
// this sandbox's Docker uses the overlayfs storage driver (no ext4/xfs
// per-volume quota support), AND — a second, independently-verified fact —
// a tmpfs-backed *named* local volume does not persist data across
// separate sequential `docker run` invocations sharing that volume name
// (confirmed directly: clone into a tmpfs-optioned volume succeeds, a
// second container mounting the same volume sees an empty directory,
// because each `docker run` remounts a fresh tmpfs when the volume's
// container reference count returns to zero). Since materialize() needs
// the SAME cloned content visible across 3-4 separate containers (fetcher
// clone -> fetcher count-gate -> scanner -> optional reader), the volume
// must be a real persistent local-driver volume, which cannot carry an
// ext4-style quota in this environment either.
//
// This is why the size cap here is a static, POST-clone `du -sk` check
// rather than a live quota. Design decision #3 rejected "polling `du`
// during clone" specifically because a counter racing an in-flight
// download is unsound; this check runs strictly AFTER the (already
// depth-1-bounded) clone has finished and the container has exited, so
// there is no race — it is a static measurement of a value that is no
// longer changing, structurally the same shape as the file-count gate
// (design step 3) that already runs post-clone, pre-scan.

export function buildDuArgs(mountPath: string): string[] {
  return ["-s", "-k", mountPath];
}

/** Parses BusyBox/coreutils `du -sk <path>` output: "<kb>\t<path>". */
export function parseDuOutputKb(stdout: string): number {
  const match = stdout.trim().match(/^(\d+)/);
  if (!match) {
    throw new Error(`disk-usage: could not parse du output: "${stdout}"`);
  }
  return Number(match[1]);
}
