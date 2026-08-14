#!/usr/bin/env node
"use strict";

// Placeholder indexer for the cbd-scanner image (Phase 1 infrastructure
// only). Emits a minimal, valid JSON blob on stdout so the container has a
// working entrypoint end to end. Real logic (denylist-filtered file walk,
// per-file LOC, language mix via the linguist-derived extension map, Semgrep
// + OSV-Scanner invocation) is implemented in Phase 3 - see design
// "Ephemeral Scan Container Design" step 4 and "Deferred Risks - Multi-
// language aggregation".

const fs = require("fs");

const ROOT = process.argv[2] || "/work";

function main() {
  const exists = fs.existsSync(ROOT);
  const output = {
    root: ROOT,
    files: [],
    totalLoc: 0,
    dominantLanguage: null,
    languageMix: [],
    findings: [],
    note: exists
      ? "placeholder indexer - real indexing lands in Phase 3"
      : `mount not found at ${ROOT}`,
  };
  process.stdout.write(JSON.stringify(output));
}

main();
