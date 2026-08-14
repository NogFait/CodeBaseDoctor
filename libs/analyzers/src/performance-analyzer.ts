import type { CategoryAnalyzer, CategoryScore, Finding, RepoContext, RepoFile } from "@cbd/analysis";

/** Reduced weight — spec: category-scoring "Performance category is capped
 * and labeled low-confidence". This is a hard requirement, not a default
 * that happens to be 0.5 today. */
const PERFORMANCE_WEIGHT_CAP = 0.5;

/** Only scan files this size or smaller, and cap how many files get
 * scanned per run. Static pattern matching over EVERY file in a large repo
 * would be slow (each readFile() is a container round-trip in production —
 * see ShallowCloneAdapter) and this heuristic is intentionally weak
 * already; scanning more files doesn't make it a stronger signal. */
const MAX_SCANNABLE_BYTES = 64 * 1024;
const MAX_FILES_SCANNED = 40;
const SCANNABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py"];

interface PerformancePattern {
  ruleId: string;
  regex: RegExp;
  severity: Finding["severity"];
  message: string;
}

const PATTERNS: PerformancePattern[] = [
  {
    ruleId: "sync-fs-call",
    regex: /\b(?:fs\.)?(readFileSync|writeFileSync|execSync|readdirSync)\b/,
    severity: "medium",
    message: "Synchronous I/O call can block the event loop under load.",
  },
  {
    ruleId: "nested-loop",
    regex: /for\s*\([^)]*\)\s*\{[^{}]*for\s*\(/,
    severity: "low",
    message: "Nested loop pattern detected — possible O(n^2) behavior worth reviewing.",
  },
];

function isScannable(file: RepoFile): boolean {
  return SCANNABLE_EXTENSIONS.some((ext) => file.path.endsWith(ext)) && file.sizeBytes <= MAX_SCANNABLE_BYTES;
}

/** Pure — matches static patterns against one file's content. */
export function findPerformanceIssues(path: string, content: string): Finding[] {
  const findings: Finding[] = [];
  for (const pattern of PATTERNS) {
    if (pattern.regex.test(content)) {
      findings.push({ ruleId: pattern.ruleId, severity: pattern.severity, path, message: pattern.message });
    }
  }
  return findings;
}

/** Pure — each finding knocks a fixed number of points off a 100 baseline. */
export function scoreFromPerformanceFindings(findings: readonly Finding[]): number {
  const penaltyBySeverity: Record<Finding["severity"], number> = { critical: 25, high: 15, medium: 8, low: 3, info: 1 };
  const penalty = findings.reduce((sum, f) => sum + penaltyBySeverity[f.severity], 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

/**
 * confidence: estimated, weightCap: 0.5 (hard spec requirement) — static
 * pattern-matching heuristics only. Explicitly a WEAK signal: this is a
 * regex sweep for a couple of well-known anti-patterns, not real profiling
 * or static analysis. The low weightCap is what tells the UI to render
 * "Low confidence — static estimate" (spec: category-scoring).
 */
export class PerformanceAnalyzer implements CategoryAnalyzer {
  readonly category = "performance" as const;
  readonly confidence = "estimated" as const;
  readonly analyzerVersion = "performance-1.0.0";

  async analyze(ctx: RepoContext, _signal: AbortSignal): Promise<CategoryScore> {
    const startedAt = Date.now();
    const candidates = ctx.files.filter(isScannable).slice(0, MAX_FILES_SCANNED);

    const findings: Finding[] = [];
    for (const file of candidates) {
      let content: string;
      try {
        content = await ctx.readFile(file.path);
      } catch {
        continue; // unreadable (too large / vanished) — skip, don't fail the whole analyzer
      }
      findings.push(...findPerformanceIssues(file.path, content));
    }

    const score = scoreFromPerformanceFindings(findings);

    return {
      category: this.category,
      status: "scored",
      score,
      confidence: this.confidence,
      weightCap: PERFORMANCE_WEIGHT_CAP,
      rationale: `Static heuristic scan over ${candidates.length} file(s); ${findings.length} pattern match(es) found. Weak signal — see weightCap.`,
      findings,
      durationMs: Date.now() - startedAt,
    };
  }
}
