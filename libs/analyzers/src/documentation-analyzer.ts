import type { CategoryAnalyzer, CategoryScore, JudgeRequest, LLMJudgePort, RepoContext } from "@cbd/analysis";

const RUBRIC_ID = "documentation-v1";
const RUBRIC_VERSION = "1.0.0";
const MAX_OUTPUT_TOKENS = 600;
// Root-level README, any casing (`readme.md`, `Readme.md`, `README.markdown`…).
// Exact-name matching used to miss every repo that doesn't shout its README,
// and the judge then scored a documented project as "no README".
const README_PATTERN = /^readme(\.(md|markdown|rst|txt|adoc))?$/i;
// Preference when several flavours coexist; "" is the extension-less `README`.
const README_EXTENSION_PRIORITY = [".md", ".markdown", ".rst", ".txt", ".adoc", ""];
const README_SAMPLE_CHARS = 4000;

const SYSTEM_PROMPT = [
  "You are scoring a codebase's DOCUMENTATION quality on a 0-100 scale.",
  "Consider: whether a README exists, whether it explains what the",
  "project does and how to run it, and whether the mix of documented vs",
  "undocumented surface area is reasonable for the repo's size. Respond",
  "with a score and a rationale grounded in the provided heuristic",
  "pre-check and README excerpt.",
].join(" ");

interface ReadmeHeuristic {
  present: boolean;
  path: string | null;
  lengthChars: number;
  excerpt: string;
}

function extensionRank(path: string): number {
  const dot = path.indexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return README_EXTENSION_PRIORITY.indexOf(extension);
}

/** Best root-level README in `ctx.files`, or null. `glob` is exact-match, so it can't do this. */
function findReadme(ctx: RepoContext): string | null {
  const candidates = ctx.files
    .map((file) => file.path)
    .filter((path) => !path.includes("/") && README_PATTERN.test(path))
    .sort((a, b) => extensionRank(a) - extensionRank(b));
  return candidates[0] ?? null;
}

async function checkReadme(ctx: RepoContext): Promise<ReadmeHeuristic> {
  const path = findReadme(ctx);
  if (path === null) {
    return { present: false, path: null, lengthChars: 0, excerpt: "" };
  }
  try {
    const content = await ctx.readFile(path);
    return { present: true, path, lengthChars: content.length, excerpt: content.slice(0, README_SAMPLE_CHARS) };
  } catch {
    // file too large to read or vanished — still "present" for the heuristic
    return { present: true, path, lengthChars: -1, excerpt: "" };
  }
}

/** Pure-ish (only I/O is the injected ctx.readFile/glob) — builds the
 * judge prompt from the README heuristic pre-check. Exported for direct
 * unit testing without a judge double. */
export function buildDocumentationUserPrompt(heuristic: ReadmeHeuristic): string {
  return [
    `README present: ${heuristic.present ? "yes" : "no"}`,
    heuristic.present ? `README path: ${heuristic.path}` : "",
    heuristic.present ? `README length: ${heuristic.lengthChars} chars` : "",
    heuristic.present ? "README excerpt:" : "",
    heuristic.excerpt,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * confidence: judged — a README-presence heuristic pre-check feeds an
 * LLMJudgePort call. Zero direct LLM SDK import. See spec: category-scoring.
 */
export class DocumentationAnalyzer implements CategoryAnalyzer {
  readonly category = "documentation" as const;
  readonly confidence = "judged" as const;
  // 1.0.1: README detection became case-insensitive (scores of repos with a
  // lowercase readme.md were wrong) — bumping invalidates those cached scans.
  readonly analyzerVersion = "documentation-1.0.1";

  constructor(private readonly judge: LLMJudgePort) {}

  async analyze(ctx: RepoContext, signal: AbortSignal): Promise<CategoryScore> {
    const startedAt = Date.now();
    const heuristic = await checkReadme(ctx);

    const request: JudgeRequest = {
      category: this.category,
      rubricId: RUBRIC_ID,
      rubricVersion: RUBRIC_VERSION,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildDocumentationUserPrompt(heuristic),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    };

    const verdict = await this.judge.judge(request, signal);

    return {
      category: this.category,
      status: "scored",
      score: verdict.score,
      confidence: this.confidence,
      weightCap: 1,
      rationale: verdict.rationale,
      findings: [],
      durationMs: Date.now() - startedAt,
    };
  }
}
