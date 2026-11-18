/** Prefix the cbd-scanner indexer puts on every diagnostic it writes to stderr. */
const SCANNER_WARNING_PREFIX = "cbd-scanner:";

/**
 * The indexer degrades instead of crashing: when semgrep or osv-scanner fails
 * (or the baked OSV DB can't be primed) it writes a `cbd-scanner: ...` line to
 * stderr, carries on with an EMPTY findings list and exits 0 — so the scan
 * "succeeds" and a vulnerable repo looks clean. Pulling those lines out lets
 * the caller log them instead of discarding stderr on a successful exit.
 * Other stderr noise (python deprecation warnings, semgrep chatter) is dropped.
 */
export function extractScannerWarnings(stderr: string): string[] {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(SCANNER_WARNING_PREFIX));
}
