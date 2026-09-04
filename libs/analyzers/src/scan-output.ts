import type { RepoContext } from "@cbd/analysis";

// The small internal seam SecurityAnalyzer reads through, per the
// orchestrator's task wording: "define a small internal interface for
// 'what a scanner CLI returns' and mock at that seam — do NOT actually
// invoke the semgrep/osv-scanner binaries, those live inside cbd-scanner's
// container per the design."
//
// Why this exists as its OWN seam rather than a RepoContext field: the
// domain's RepoContext type (Phase 2, design "Domain types") has no raw
// findings field — only file metadata (path/sizeBytes/loc/language). Real
// Semgrep/OSV-Scanner output is a scan RESULT, not repo content, so
// bolting it onto RepoContext would blur that line. The convention
// established here: the scanner container is expected to write its raw
// findings JSON to a well-known path inside the materialized workspace
// (`.cbd/scan-findings.json`), readable through the SAME RepoContext.readFile()
// every other analyzer already uses — no new port, no CategoryAnalyzer
// signature change.
//
// Task 3.2.8 (done): the cbd-scanner indexer now invokes Semgrep (a small
// vendored local rule set, see apps/worker/docker/semgrep-rules/security.yaml)
// and OSV-Scanner (offline, against npm/PyPI vulnerability DBs baked into
// the image at build time — see apps/worker/docker/cbd-scanner.Dockerfile)
// against the mounted read-only repo, and emits the combined findings on
// its stdout JSON blob. `DefaultScanOutputReader` reads them via
// `ctx.readFile(SCAN_FINDINGS_PATH)` exactly as this file always expected —
// but the underlying transport is NOT a real file on the volume (the
// scanner container mounts it `:ro`, so the indexer can never write there).
// `ShallowCloneAdapter.buildRepoContext()` special-cases this well-known
// path and synthesizes the JSON in-memory from the SAME stdout blob the
// file walk came from (see its `readFile()` doc comment for the full
// reasoning). Real repos now score Security below 100 when findings exist;
// see libs/repo-source/src/shallow-clone-adapter.integration.spec.ts for an
// end-to-end proof against real Docker containers.

export type ScanFindingSeverity = "info" | "low" | "medium" | "high" | "critical";
export type ScanFindingSource = "semgrep" | "osv-scanner";

export interface RawScanFinding {
  ruleId: string;
  severity: ScanFindingSeverity;
  path?: string;
  line?: number;
  message: string;
  source: ScanFindingSource;
}

export interface ScanOutput {
  findings: readonly RawScanFinding[];
}

export interface ScanOutputReader {
  read(ctx: RepoContext): Promise<ScanOutput>;
}

const SCAN_FINDINGS_PATH = ".cbd/scan-findings.json";

export class DefaultScanOutputReader implements ScanOutputReader {
  async read(ctx: RepoContext): Promise<ScanOutput> {
    try {
      const raw = await ctx.readFile(SCAN_FINDINGS_PATH);
      const parsed = JSON.parse(raw) as ScanOutput;
      return { findings: parsed.findings ?? [] };
    } catch {
      return { findings: [] };
    }
  }
}
