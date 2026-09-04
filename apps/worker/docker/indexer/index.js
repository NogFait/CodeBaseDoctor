#!/usr/bin/env node
"use strict";

// Real cbd-scanner indexer (Phase 3, task 3.2.8). Walks the read-only mounted
// repo, applies the denylist RepoContext's doc comment promises
// ("node_modules, dist, vendor, *.min.*, lockfiles"), invokes Semgrep and
// OSV-Scanner against the SAME mounted tree (both fully offline — see
// runSemgrep/runOsvScanner below and cbd-scanner.Dockerfile for how the
// rules/vulnerability DB got baked in at build time), and emits one JSON
// blob on stdout with per-file path/sizeBytes/loc PLUS the combined
// findings array. ShallowCloneAdapter (libs/repo-source) turns this into a
// RepoContext — language detection and languageMix/totalLoc aggregation
// happen adapter-side (kept in one place, shared with FixtureRepoSource's
// convention from Phase 2); `findings` is threaded through to
// RepoContext.readFile('.cbd/scan-findings.json') so SecurityAnalyzer's
// ScanOutputReader seam (libs/analyzers/src/scan-output.ts) reads real data
// instead of always resolving `{findings: []}` — see that adapter's doc
// comment for why this is synthesized in-memory rather than written as a
// literal file (the volume is mounted `:ro` for this container).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

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

function toRelativePath(root, absPath) {
  if (!absPath) return undefined;
  return path.relative(root, absPath).split(path.sep).join("/");
}

// ---- Semgrep: local, vendored rules only — zero network, ever -------------
//
// `--config auto`/`p/ci` (Semgrep's typical usage) fetches rules from
// Semgrep's registry over the network, which this container cannot reach
// (`--network none` at scan time — see cbd-scanner.Dockerfile). Instead we
// invoke `--config /opt/semgrep-rules`, a small curated rule file baked
// into the image at build time (see semgrep-rules/security.yaml: hardcoded
// secrets, eval/exec, SQL string concatenation — a handful of high-signal
// rules, not a full registry mirror, per this task's scope). `--metrics=off`
// disables semgrep's own anonymous-usage-metrics network call, which would
// otherwise be attempted (and silently fail under --network none) on every
// invocation.

const SEMGREP_BIN = process.env.CBD_SEMGREP_BIN || "semgrep";
const SEMGREP_CONFIG = process.env.CBD_SEMGREP_CONFIG || "/opt/semgrep-rules";

// Fallback only — used when a rule doesn't set the custom `cbd-severity`
// metadata field (every rule in semgrep-rules/security.yaml DOES set it;
// this only matters if a rule is added later without one).
const SEMGREP_SEVERITY_FALLBACK = { ERROR: "high", WARNING: "medium", INFO: "low" };

function runSemgrep(root) {
  let raw;
  try {
    raw = execFileSync(
      SEMGREP_BIN,
      ["--config", SEMGREP_CONFIG, "--json", "--metrics=off", "--timeout", "120", root],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 150_000 },
    );
  } catch (err) {
    // Semgrep exits non-zero for reasons that are NOT "the scan failed" —
    // e.g. one rule erroring on one file while every other rule/file still
    // ran to completion; `err.stdout` still carries the full JSON result in
    // that case (verified directly). Only a missing/empty stdout means the
    // invocation itself genuinely failed.
    raw = err.stdout ? err.stdout.toString("utf8") : "";
    if (!raw) {
      process.stderr.write(`cbd-scanner: semgrep invocation failed: ${err.message}\n`);
      return [];
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`cbd-scanner: semgrep produced non-JSON output: ${err.message}\n`);
    return [];
  }

  return (parsed.results || []).map((r) => {
    // check_id comes back as "opt.semgrep-rules.<rule-id>" (semgrep derives
    // an id prefix from the config path for loose, non-registry rule
    // files) — verified directly. Our own rule ids (hardcoded-secret,
    // dangerous-eval, sql-string-concatenation) contain no dots, so the
    // last dot-segment is always the real rule id.
    const ruleId = String(r.check_id || "unknown-rule").split(".").pop();
    const cbdSeverity = r.extra && r.extra.metadata && r.extra.metadata["cbd-severity"];
    const fallbackSeverity = SEMGREP_SEVERITY_FALLBACK[(r.extra && r.extra.severity) || ""] || "medium";
    return {
      ruleId,
      severity: cbdSeverity || fallbackSeverity,
      path: toRelativePath(root, r.path),
      line: r.start && typeof r.start.line === "number" ? r.start.line : undefined,
      message: (r.extra && r.extra.message) || ruleId,
      source: "semgrep",
    };
  });
}

// ---- OSV-Scanner: offline vulnerability DB baked at build time ------------
//
// OSV-Scanner's default lookup queries the OSV.dev API over the network.
// v1.9.1 ships `--experimental-offline-vulnerabilities` (match against
// whatever per-ecosystem DB is already on disk, zero network) paired with
// `--experimental-download-offline-databases` (fetch that DB once — done at
// BUILD time in cbd-scanner.Dockerfile's osv-db-stage, which DOES have
// network, for the npm and PyPI ecosystems this project's own fixtures use).
//
// The baked DB lives at a permanent path (`/opt/osv-db`, read-only at scan
// time) because `--tmpfs /tmp` is a FRESH, empty filesystem on every
// container start (same lesson already learned for the fetcher/scanner
// clone volume in Phase 3 batch A — a baked-in path under `/opt` can't rely
// on `/tmp` surviving between builds and runs). osv-scanner resolves its
// cache dir via `$XDG_CACHE_HOME/osv-scanner` (pinned to `/tmp` in the
// Dockerfile), so every scan copies the baked DB into that writable tmpfs
// location before invoking osv-scanner — verified directly end-to-end with
// `--network none`: a copied DB is found and used with zero network calls;
// a MISSING one fails loudly ("could not find local databases") rather than
// silently reporting a clean scan.

const OSV_SCANNER_BIN = process.env.CBD_OSV_SCANNER_BIN || "osv-scanner";
const OSV_DB_SEED_DIR = process.env.CBD_OSV_DB_SEED || "/opt/osv-db";
const OSV_CACHE_HOME = process.env.XDG_CACHE_HOME || "/tmp";

// OSV/GHSA's own severity vocabulary (`database_specific.severity`), mapped
// to CBD's fixed 5-level scale. Not every advisory carries this field (some
// ship only a raw CVSS vector, no bucketed label) — those findings fall
// back to "medium", a deliberately conservative default: never silently
// downgraded to "low", never over-claimed as "critical" without evidence.
const OSV_SEVERITY_MAP = {
  CRITICAL: "critical",
  HIGH: "high",
  MODERATE: "medium",
  MEDIUM: "medium",
  LOW: "low",
};

function primeOsvOfflineDb() {
  const dest = path.join(OSV_CACHE_HOME, "osv-scanner");
  try {
    if (fs.existsSync(OSV_DB_SEED_DIR)) {
      fs.cpSync(OSV_DB_SEED_DIR, dest, { recursive: true });
    } else {
      process.stderr.write(`cbd-scanner: no baked OSV offline DB found at ${OSV_DB_SEED_DIR}\n`);
    }
  } catch (err) {
    process.stderr.write(`cbd-scanner: failed to prime osv-scanner offline DB: ${err.message}\n`);
  }
}

function runOsvScanner(root) {
  primeOsvOfflineDb();

  let raw;
  try {
    raw = execFileSync(
      OSV_SCANNER_BIN,
      ["scan", "--recursive", "--experimental-offline-vulnerabilities", "--format", "json", root],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 150_000 },
    );
  } catch (err) {
    // osv-scanner's own documented exit-code convention (verified directly
    // against the real 1.9.1 binary): 0 = no vulnerabilities found, 1 =
    // vulnerabilities WERE found — that is success, not a crash.
    // `err.stdout` still carries the full JSON result on a "1" exit; only a
    // missing/unparseable stdout means the invocation itself failed.
    raw = err.stdout ? err.stdout.toString("utf8") : "";
    if (!raw) {
      process.stderr.write(`cbd-scanner: osv-scanner invocation failed: ${err.message}\n`);
      return [];
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`cbd-scanner: osv-scanner produced non-JSON output: ${err.message}\n`);
    return [];
  }

  const findings = [];
  for (const result of parsed.results || []) {
    const relPath = result.source ? toRelativePath(root, result.source.path) : undefined;
    for (const pkg of result.packages || []) {
      const pkgName = (pkg.package && pkg.package.name) || "unknown-package";
      const pkgVersion = (pkg.package && pkg.package.version) || "";
      for (const vuln of pkg.vulnerabilities || []) {
        const rawSeverity = vuln.database_specific && vuln.database_specific.severity;
        const severity = OSV_SEVERITY_MAP[String(rawSeverity || "").toUpperCase()] || "medium";
        findings.push({
          ruleId: vuln.id || (vuln.aliases && vuln.aliases[0]) || "unknown-vulnerability",
          severity,
          path: relPath,
          message: `${pkgName}@${pkgVersion}: ${vuln.summary || vuln.id || "known vulnerability"}`,
          source: "osv-scanner",
        });
      }
    }
  }
  return findings;
}

function main() {
  const exists = fs.existsSync(ROOT);
  const files = [];
  let semgrepFindings = [];
  let osvFindings = [];

  if (exists) {
    walk(ROOT, ROOT, files);
    semgrepFindings = runSemgrep(ROOT);
    osvFindings = runOsvScanner(ROOT);
  }

  const findings = [...semgrepFindings, ...osvFindings];

  const output = {
    root: ROOT,
    files,
    findings,
    note: exists
      ? `real walk (Phase 3) + semgrep (${semgrepFindings.length} findings, local rules) + osv-scanner (${osvFindings.length} findings, offline npm/PyPI DBs)`
      : `mount not found at ${ROOT}`,
  };
  process.stdout.write(JSON.stringify(output));
}

main();
