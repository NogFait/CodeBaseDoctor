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
// Real gap, flagged honestly (see apply-progress): the cbd-scanner
// indexer upgraded in this batch does real file walking/LOC but does NOT
// yet invoke Semgrep/OSV-Scanner or write this file — that wiring is
// out of scope for "implement ShallowCloneAdapter + the 6 analyzers" and
// is called out as a followup. Until then, DefaultScanOutputReader always
// resolves to `{ findings: [] }` in real ingestion, which is honest (no
// findings claimed) rather than faked.

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
