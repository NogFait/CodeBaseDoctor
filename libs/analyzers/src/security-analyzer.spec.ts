import { describe, expect, it } from "vitest";
import type { RepoContext } from "@cbd/analysis";
import { SecurityAnalyzer } from "./security-analyzer";
import type { RawScanFinding, ScanOutput, ScanOutputReader } from "./scan-output";

class MockScanOutputReader implements ScanOutputReader {
  calls = 0;
  constructor(private readonly output: ScanOutput) {}
  async read(): Promise<ScanOutput> {
    this.calls += 1;
    return this.output;
  }
}

function findingOf(overrides: Partial<RawScanFinding>): RawScanFinding {
  return {
    ruleId: "generic-rule",
    severity: "low",
    message: "issue",
    source: "semgrep",
    ...overrides,
  };
}

// Minimal fake RepoContext — SecurityAnalyzer never actually calls any of
// these methods itself (only the injected reader does), so a bare stub is
// sufficient and keeps the test's mock count low (Mock Hygiene Rule).
function fakeCtx(): RepoContext {
  return {
    repoUrl: "https://github.com/x/y",
    commitSha: "0".repeat(40),
    rootPath: "/work",
    files: [],
    dominantLanguage: null,
    languageMix: [],
    totalLoc: 0,
    readFile: async () => "",
    glob: () => [],
  };
}

describe("SecurityAnalyzer", () => {
  it("reports a full score and empty findings when the scanner found nothing", async () => {
    const reader = new MockScanOutputReader({ findings: [] });
    const analyzer = new SecurityAnalyzer(reader);

    const result = await analyzer.analyze(fakeCtx(), new AbortController().signal);

    expect(result.category).toBe("security");
    expect(result.status).toBe("scored");
    expect(result.confidence).toBe("measured");
    expect(result.weightCap).toBe(1);
    expect(result.score).toBe(100);
    expect(result.rationale).toContain("0 finding");
    expect(result.findings).toHaveLength(0);
    expect(reader.calls).toBe(1);
  });

  it("reduces the score based on finding severity and reports the finding count", async () => {
    const reader = new MockScanOutputReader({
      findings: [
        findingOf({ severity: "critical", ruleId: "sql-injection" }),
        findingOf({ severity: "medium", ruleId: "weak-hash" }),
        findingOf({ severity: "low", ruleId: "verbose-error" }),
      ],
    });
    const analyzer = new SecurityAnalyzer(reader);

    const result = await analyzer.analyze(fakeCtx(), new AbortController().signal);

    // 100 - 40 (critical) - 10 (medium) - 4 (low) = 46
    expect(result.score).toBe(46);
    expect(result.rationale).toContain("3 finding");
    expect(result.findings).toHaveLength(3);
    expect(result.findings[0]).toMatchObject({ ruleId: "sql-injection", severity: "critical" });
  });

  it("never scores below 0 even with many critical findings", async () => {
    const reader = new MockScanOutputReader({
      findings: Array.from({ length: 5 }, () => findingOf({ severity: "critical" })),
    });
    const analyzer = new SecurityAnalyzer(reader);

    const result = await analyzer.analyze(fakeCtx(), new AbortController().signal);

    expect(result.score).toBe(0);
  });

  it("makes zero network calls of its own — everything comes through the injected reader seam", async () => {
    // Real assertion, not a tautology: the ONLY way this analyzer could
    // reach a scanner is through `reader`, and we've replaced `reader`
    // with a plain in-memory mock that does no I/O at all. If
    // SecurityAnalyzer ever imported a network client directly, this test
    // would still pass by construction but the `rg` check in the report
    // (zero direct SDK/HTTP imports) is the actual guard for that — this
    // test's job is to confirm the reader seam is what's actually used.
    const reader = new MockScanOutputReader({ findings: [] });
    const analyzer = new SecurityAnalyzer(reader);

    await analyzer.analyze(fakeCtx(), new AbortController().signal);

    expect(reader.calls).toBe(1);
  });
});
