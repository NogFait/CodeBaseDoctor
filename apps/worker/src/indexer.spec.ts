import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// The cbd-scanner indexer is a plain CommonJS script baked into the scanner
// image (apps/worker/docker/indexer/index.js); it is loaded here, not run.
const require = createRequire(__filename);
const indexer = require("../docker/indexer/index.js") as {
  buildSemgrepArgs: (root: string) => string[];
  isNoPackageSourcesError: (err: { status?: number } | null | undefined) => boolean;
};

describe("indexer: semgrep invocation", () => {
  it("disables Semgrep's version check — the scanner container has no network, so the check just waits ~45s for a timeout on every scan", () => {
    expect(indexer.buildSemgrepArgs("/work/repo")).toContain("--disable-version-check");
  });

  it("keeps the offline-safe flags and scans the given root last", () => {
    const args = indexer.buildSemgrepArgs("/work/repo");

    expect(args).toContain("--json");
    expect(args).toContain("--metrics=off");
    expect(args[args.indexOf("--config") + 1]).toBe("/opt/semgrep-rules");
    expect(args[args.length - 1]).toBe("/work/repo");
  });
});

describe("indexer: osv-scanner exit codes", () => {
  it("exit 128 ('No package sources found') is the normal result for a repo without lockfiles, not a failure", () => {
    expect(indexer.isNoPackageSourcesError({ status: 128 })).toBe(true);
  });

  it("any other failure is still a failure", () => {
    expect(indexer.isNoPackageSourcesError({ status: 127 })).toBe(false); // e.g. offline DB missing
    expect(indexer.isNoPackageSourcesError({ status: 1 })).toBe(false); // 1 = vulnerabilities found, handled elsewhere
    expect(indexer.isNoPackageSourcesError({})).toBe(false);
    expect(indexer.isNoPackageSourcesError(null)).toBe(false);
  });
});
