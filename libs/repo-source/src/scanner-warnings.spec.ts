import { describe, expect, it } from "vitest";
import { extractScannerWarnings } from "./scanner-warnings";

/**
 * The cbd-scanner indexer reports degraded scans (semgrep / osv-scanner
 * failing, the baked OSV DB missing...) on stderr with a `cbd-scanner:`
 * prefix, then exits 0 with an EMPTY findings list. That is a silent
 * "everything is clean" unless somebody reads stderr.
 */
describe("extractScannerWarnings", () => {
  it("returns the indexer's own warning lines", () => {
    const stderr = [
      "cbd-scanner: failed to prime osv-scanner offline DB: ENOSPC: no space left on device",
      "cbd-scanner: osv-scanner invocation failed: Command failed",
      "",
    ].join("\n");

    expect(extractScannerWarnings(stderr)).toEqual([
      "cbd-scanner: failed to prime osv-scanner offline DB: ENOSPC: no space left on device",
      "cbd-scanner: osv-scanner invocation failed: Command failed",
    ]);
  });

  it("ignores unrelated stderr noise (python deprecation warnings, semgrep chatter)", () => {
    const stderr = [
      "/opt/semgrep-venv/lib/python3.12/site-packages/opentelemetry/instrumentation/dependencies.py:4: UserWarning: pkg_resources is deprecated",
      "  from pkg_resources import iter_entry_points",
      "cbd-scanner: semgrep produced non-JSON output: Unexpected token",
    ].join("\n");

    expect(extractScannerWarnings(stderr)).toEqual(["cbd-scanner: semgrep produced non-JSON output: Unexpected token"]);
  });

  it("tolerates CRLF, indentation and blank lines", () => {
    const stderr = "\r\n  cbd-scanner: no baked OSV offline DB found at /opt/osv-db\r\n\r\n";

    expect(extractScannerWarnings(stderr)).toEqual(["cbd-scanner: no baked OSV offline DB found at /opt/osv-db"]);
  });

  it("returns an empty list for a clean or empty stderr", () => {
    expect(extractScannerWarnings("")).toEqual([]);
    expect(extractScannerWarnings("some unrelated line\n")).toEqual([]);
  });
});
