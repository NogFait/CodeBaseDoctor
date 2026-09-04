import { describe, expect, it } from "vitest";
import { computeEngineVersion } from "./engine-version";

describe("computeEngineVersion", () => {
  it("is a fixed-length hex fingerprint of the category:version pairs", () => {
    const result = computeEngineVersion([
      { category: "security", analyzerVersion: "security-1.0.0" },
      { category: "testing", analyzerVersion: "testing-1.0.0" },
    ]);
    expect(result).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is independent of input order (RepoAnalysisService and the API map their own array order)", () => {
    const inOrder = computeEngineVersion([
      { category: "security", analyzerVersion: "security-1.0.0" },
      { category: "testing", analyzerVersion: "testing-1.0.0" },
      { category: "architecture", analyzerVersion: "architecture-1.0.0" },
    ]);
    const reversed = computeEngineVersion([
      { category: "architecture", analyzerVersion: "architecture-1.0.0" },
      { category: "testing", analyzerVersion: "testing-1.0.0" },
      { category: "security", analyzerVersion: "security-1.0.0" },
    ]);
    expect(inOrder).toBe(reversed);
  });

  it("changes when any single analyzerVersion changes (cache-busting)", () => {
    const before = computeEngineVersion([{ category: "security", analyzerVersion: "security-1.0.0" }]);
    const after = computeEngineVersion([{ category: "security", analyzerVersion: "security-1.0.1" }]);
    expect(before).not.toBe(after);
  });

  it("produces the same output whether entries come from live analyzer-shaped objects or a plain versions record", () => {
    // Mirrors the two real call sites: RepoAnalysisService maps its injected
    // CATEGORY_ANALYZERS array (live analyzer instances) to entries;
    // apps/api maps the static ANALYZER_VERSIONS record to the same entry
    // shape. Both MUST produce the same engineVersion for equivalent
    // underlying versions, or cache lookups silently always miss.
    const versionsRecord: Record<string, string> = {
      security: "security-1.0.0",
      testing: "testing-1.0.0",
    };
    const fromLiveAnalyzers = computeEngineVersion([
      { category: "security", analyzerVersion: "security-1.0.0" },
      { category: "testing", analyzerVersion: "testing-1.0.0" },
    ]);
    const fromStaticManifest = computeEngineVersion(
      Object.entries(versionsRecord).map(([category, analyzerVersion]) => ({ category, analyzerVersion })),
    );
    expect(fromLiveAnalyzers).toBe(fromStaticManifest);
  });
});
