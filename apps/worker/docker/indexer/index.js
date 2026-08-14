#!/usr/bin/env node
"use strict";

// Real cbd-scanner indexer (Phase 3). Walks the read-only mounted repo,
// applies the denylist RepoContext's doc comment promises ("node_modules,
// dist, vendor, *.min.*, lockfiles"), and emits one JSON blob on stdout with
// per-file path/sizeBytes/loc. ShallowCloneAdapter (libs/repo-source) turns
// this into a RepoContext — language detection and languageMix/totalLoc
// aggregation happen adapter-side (kept in one place, shared with
// FixtureRepoSource's convention from Phase 2).
//
// Deliberately NOT included in this pass: Semgrep + OSV-Scanner invocation.
// `findings` ships as an empty array — SecurityAnalyzer (libs/analyzers)
// consumes findings through its own ScanOutputReader seam, which today has
// nothing to read because no scanner writes to it yet. This is a real,
// flagged gap for a follow-up batch, not something faked here. See
// apply-progress for the full reasoning.

const fs = require("fs");
const path = require("path");

const ROOT = process.argv[2] || "/work";

const DENYLIST_DIRS = new Set(["node_modules", "dist", "build", "vendor", ".git"]);
const DENYLIST_FILE_PATTERNS = [/\.min\.[a-z]+$/i, /package-lock\.json$/, /pnpm-lock\.yaml$/, /yarn\.lock$/, /\.lock$/];

function isDenylistedFile(relPath) {
  const base = path.basename(relPath);
  return DENYLIST_FILE_PATTERNS.some((re) => re.test(base));
}

/** Line count matching `wc -l` semantics — same convention as
 * FixtureRepoSource.countLoc (Phase 2) so a fixture-driven unit test and a
 * real scan produce comparable numbers for the same content. */
function countLoc(content) {
  if (content.length === 0) return 0;
  const lines = content.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function walk(root, dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && DENYLIST_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const relPath = path.relative(root, full).split(path.sep).join("/");
    if (isDenylistedFile(relPath)) continue;

    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }

    let loc = 0;
    // Only count lines for files small enough to be a real source file —
    // mirrors the 512KB readFile() cap so the indexer never chokes trying to
    // line-count something huge that was already meant to be skipped by
    // readers downstream.
    if (stat.size <= 512 * 1024) {
      try {
        loc = countLoc(fs.readFileSync(full, "utf8"));
      } catch {
        loc = 0; // binary or unreadable — sizeBytes still recorded
      }
    }

    out.push({ path: relPath, sizeBytes: stat.size, loc });
  }
}

function main() {
  const exists = fs.existsSync(ROOT);
  const files = [];
  if (exists) {
    walk(ROOT, ROOT, files);
  }
  const output = {
    root: ROOT,
    files,
    findings: [],
    note: exists ? "real walk (Phase 3) — no Semgrep/OSV-Scanner invocation yet" : `mount not found at ${ROOT}`,
  };
  process.stdout.write(JSON.stringify(output));
}

main();
