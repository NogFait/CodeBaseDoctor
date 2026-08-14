// Domain types for the analysis engine. Pure TypeScript — zero runtime
// dependency on Prisma, Docker, an LLM SDK, or HTTP. This is the hexagonal
// core; adapters (Phase 3) map their own shapes onto these at the boundary.
// See design: "Interfaces / Contracts > Domain types".

export type CategoryId =
  | "architecture"
  | "security"
  | "testing"
  | "maintainability"
  | "performance"
  | "documentation";

export type Confidence = "measured" | "estimated" | "judged";

export interface RepoFile {
  path: string;
  sizeBytes: number;
  loc: number;
  language: string | null;
}

/** share is a fraction in [0,1] of the repo's total LOC attributed to this language. */
export interface LanguageShare {
  language: string;
  loc: number;
  share: number;
}

/**
 * Read model handed to every analyzer. The ONLY way an analyzer sees repo
 * bytes — analyzers never touch the filesystem or Docker directly.
 */
export interface RepoContext {
  readonly repoUrl: string;
  readonly commitSha: string;
  /** Read-only mount path inside the scanner container. */
  readonly rootPath: string;
  /** Denylist already applied (node_modules, dist, vendor, *.min.*, lockfiles). */
  readonly files: readonly RepoFile[];
  readonly dominantLanguage: string | null;
  readonly languageMix: readonly LanguageShare[];
  readonly totalLoc: number;
  /** Throws FileTooLargeError if the file is over 512KB. */
  readFile(path: string): Promise<string>;
  /** In-memory glob over `files`, no filesystem hit. */
  glob(pattern: string): readonly string[];
}

export interface Finding {
  ruleId: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  path?: string;
  line?: number;
  message: string;
}

export interface CategoryScore {
  category: CategoryId;
  status: "scored" | "failed" | "skipped";
  /** 0-100; null unless status === 'scored'. */
  score: number | null;
  confidence: Confidence;
  /** 1.0 for all categories except Performance (0.5, reduced weight). */
  weightCap: number;
  /** Always populated, even on failure. */
  rationale: string;
  findings: readonly Finding[];
  error?: { code: string; message: string };
  durationMs: number;
}

export interface RepoScoreReport {
  repoUrl: string;
  commitSha: string;
  engineVersion: string;
  status: "complete" | "partial";
  /** Weighted mean over status === 'scored' categories only. */
  compositeScore: number | null;
  /** scoredCount / 6 */
  completeness: number;
  dominantLanguage: string | null;
  languageMix: readonly LanguageShare[];
  /** ALWAYS length 6 — a category is never silently dropped. */
  categories: readonly CategoryScore[];
  createdAt: Date;
}

/** RepoContext.readFile() throws this over the 512KB per-file read limit. */
export const MAX_READABLE_FILE_BYTES = 512 * 1024;
