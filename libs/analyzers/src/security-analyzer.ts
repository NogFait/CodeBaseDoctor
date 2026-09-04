import type { CategoryAnalyzer, CategoryScore, Finding, RepoContext } from "@cbd/analysis";
import { DefaultScanOutputReader, type RawScanFinding, type ScanOutputReader } from "./scan-output";

const SEVERITY_PENALTY: Record<RawScanFinding["severity"], number> = {
  critical: 40,
  high: 20,
  medium: 10,
  low: 4,
  info: 1,
};

/** Pure — 100 minus a per-severity penalty per finding, clamped to [0,100]. */
export function scoreFromFindings(findings: readonly RawScanFinding[]): number {
  const penalty = findings.reduce((sum, f) => sum + SEVERITY_PENALTY[f.severity], 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

function toDomainFinding(f: RawScanFinding): Finding {
  return { ruleId: f.ruleId, severity: f.severity, path: f.path, line: f.line, message: f.message };
}

/**
 * confidence: measured — Semgrep + OSV-Scanner findings via the
 * ScanOutputReader seam (scan-output.ts). Never invokes a scanner binary
 * directly; those run for real inside the network-isolated cbd-scanner
 * container (apps/worker/docker/indexer/index.js, task 3.2.8) per design.
 * See spec: category-scoring.
 */
export class SecurityAnalyzer implements CategoryAnalyzer {
  readonly category = "security" as const;
  readonly confidence = "measured" as const;
  readonly analyzerVersion = "security-1.0.0";

  constructor(private readonly reader: ScanOutputReader = new DefaultScanOutputReader()) {}

  async analyze(ctx: RepoContext, _signal: AbortSignal): Promise<CategoryScore> {
    const startedAt = Date.now();
    const { findings } = await this.reader.read(ctx);
    const score = scoreFromFindings(findings);

    return {
      category: this.category,
      status: "scored",
      score,
      confidence: this.confidence,
      weightCap: 1,
      rationale: `${findings.length} finding${findings.length === 1 ? "" : "s"} from Semgrep + OSV-Scanner.`,
      findings: findings.map(toDomainFinding),
      durationMs: Date.now() - startedAt,
    };
  }
}
