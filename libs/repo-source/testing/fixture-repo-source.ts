import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  FileTooLargeError,
  MAX_READABLE_FILE_BYTES,
  type LanguageShare,
  type RepoContext,
  type RepoFile,
} from "@cbd/analysis";
import type {
  IngestionLimits,
  RepoMetadata,
  RepoRef,
  RepoSourcePort,
  RepoWorkspace,
} from "@cbd/analysis";

// Extension -> language map. Deliberately small (mirrors the linguist-derived
// map the real LanguageDetector will use in Phase 3) — enough to make the
// three committed fixtures structurally real. Non-code files (json/md/txt)
// map to `null` and are excluded from totalLoc/languageMix, matching how a
// real language mix should read (config/docs don't count as "language").
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".py": "Python",
};

// Mirrors design's "if the top share is under 0.40, dominantLanguage stays
// null" rule from the Deferred Risks table (Multi-language aggregation).
const DOMINANT_LANGUAGE_SHARE_THRESHOLD = 0.4;

function detectLanguage(relPath: string): string | null {
  return LANGUAGE_BY_EXTENSION[path.extname(relPath)] ?? null;
}

/** Line count matching `wc -l` semantics: newline-terminated lines, no
 * phantom line for a trailing newline, and 0 for an empty file. */
function countLoc(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

async function listFilesRecursive(root: string, dir: string = root): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(root, full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export interface FixtureRepoContextOptions {
  repoUrl: string;
  commitSha: string;
}

/**
 * Builds a real RepoContext by reading a committed fixture directory from
 * disk. No mocking of file contents — `files`, `dominantLanguage`, and
 * `totalLoc` are derived from what is actually on disk under `fixtureDir`.
 */
export async function buildFixtureRepoContext(
  fixtureDir: string,
  options: FixtureRepoContextOptions,
): Promise<RepoContext> {
  const absolutePaths = await listFilesRecursive(fixtureDir);
  const contents = new Map<string, string>();
  const files: RepoFile[] = [];

  for (const absPath of absolutePaths) {
    const relPath = path.relative(fixtureDir, absPath).split(path.sep).join("/");
    const stat = await fs.stat(absPath);
    const content = await fs.readFile(absPath, "utf8");
    contents.set(relPath, content);
    files.push({
      path: relPath,
      sizeBytes: stat.size,
      loc: countLoc(content),
      language: detectLanguage(relPath),
    });
  }

  const locByLanguage = new Map<string, number>();
  for (const file of files) {
    if (file.language === null) continue;
    locByLanguage.set(file.language, (locByLanguage.get(file.language) ?? 0) + file.loc);
  }
  const totalLoc = [...locByLanguage.values()].reduce((sum, n) => sum + n, 0);
  const languageMix: LanguageShare[] = [...locByLanguage.entries()]
    .map(([language, loc]) => ({ language, loc, share: totalLoc === 0 ? 0 : loc / totalLoc }))
    .sort((a, b) => b.loc - a.loc);
  const dominantLanguage =
    languageMix.length > 0 && languageMix[0].share >= DOMINANT_LANGUAGE_SHARE_THRESHOLD
      ? languageMix[0].language
      : null;

  return {
    repoUrl: options.repoUrl,
    commitSha: options.commitSha,
    rootPath: fixtureDir,
    files,
    dominantLanguage,
    languageMix,
    totalLoc,
    async readFile(filePath: string): Promise<string> {
      const content = contents.get(filePath);
      if (content === undefined) {
        throw new Error(`FixtureRepoSource: unknown file "${filePath}"`);
      }
      const sizeBytes = Buffer.byteLength(content, "utf8");
      if (sizeBytes > MAX_READABLE_FILE_BYTES) {
        throw new FileTooLargeError(filePath, sizeBytes, MAX_READABLE_FILE_BYTES);
      }
      return content;
    },
    glob(pattern: string): readonly string[] {
      // Minimal in-memory glob — only supports an exact path or a "**/*.ext"
      // suffix match. Enough for fixture-driven unit tests; not a general
      // glob engine.
      if (pattern.startsWith("**/*")) {
        const suffix = pattern.slice(4);
        return files.map((f) => f.path).filter((p) => p.endsWith(suffix));
      }
      return files.map((f) => f.path).filter((p) => p === pattern);
    },
  };
}

/**
 * Test double for RepoSourcePort. `materialize()` returns a RepoContext
 * built from a committed fixture tree on disk instead of cloning/scanning.
 * See design: "Testing Strategy".
 */
export class FixtureRepoSource implements RepoSourcePort {
  constructor(
    private readonly fixtureDir: string,
    private readonly repoUrl: string = "https://github.com/fixture/fixture",
  ) {}

  async resolve(url: string): Promise<RepoRef> {
    return { host: "github", owner: "fixture", repo: "fixture", url };
  }

  async head(_ref: RepoRef): Promise<RepoMetadata> {
    return { defaultBranch: "main", headSha: "0".repeat(40), sizeKb: 1, visibility: "public" };
  }

  async materialize(
    _ref: RepoRef,
    sha: string,
    _limits: IngestionLimits,
  ): Promise<RepoWorkspace> {
    const context = await buildFixtureRepoContext(this.fixtureDir, {
      repoUrl: this.repoUrl,
      commitSha: sha,
    });
    return { context, dispose: async () => {} };
  }
}
