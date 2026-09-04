import { describe, expect, it } from "vitest";
import { AnalysisBelowThresholdError, FileTooLargeError } from "./errors";
import { MAX_READABLE_FILE_BYTES, type RepoScoreReport } from "./types";

describe("FileTooLargeError", () => {
  it("carries the offending path, size, and limit", () => {
    const err = new FileTooLargeError("src/big-file.ts", 600_000, MAX_READABLE_FILE_BYTES);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("FileTooLargeError");
    expect(err.path).toBe("src/big-file.ts");
    expect(err.sizeBytes).toBe(600_000);
    expect(err.maxBytes).toBe(MAX_READABLE_FILE_BYTES);
    expect(err.message).toContain("src/big-file.ts");
    expect(err.message).toContain("600000");
  });

  it("triangulates with different path/size inputs to prove the message is derived, not hardcoded", () => {
    const err = new FileTooLargeError("data/dump.json", 1_048_576, MAX_READABLE_FILE_BYTES);

    expect(err.path).toBe("data/dump.json");
    expect(err.sizeBytes).toBe(1_048_576);
    expect(err.message).toContain("data/dump.json");
    expect(err.message).toContain("1048576");
  });
});

describe("MAX_READABLE_FILE_BYTES", () => {
  it("is exactly 512KB per the design's RepoContext.readFile contract", () => {
    expect(MAX_READABLE_FILE_BYTES).toBe(512 * 1024);
  });
});

describe("AnalysisBelowThresholdError", () => {
  function fakeReport(categoriesLength = 6): RepoScoreReport {
    return {
      repoUrl: "https://github.com/acme/widget",
      commitSha: "a".repeat(40),
      engineVersion: "1.0.0",
      status: "partial",
      compositeScore: 42,
      completeness: 3 / 6,
      dominantLanguage: "TypeScript",
      languageMix: [],
      categories: new Array(categoriesLength).fill(null),
      createdAt: new Date("2026-01-01T00:00:00Z"),
    } as unknown as RepoScoreReport;
  }

  it("carries the scored count, the minimum required, and the underlying report", () => {
    const report = fakeReport();
    const err = new AnalysisBelowThresholdError(3, 4, report);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AnalysisBelowThresholdError");
    expect(err.scoredCount).toBe(3);
    expect(err.minimumRequired).toBe(4);
    expect(err.report).toBe(report);
    expect(err.message).toContain("3");
    expect(err.message).toContain("4");
  });

  it("triangulates with different counts to prove the message is derived, not hardcoded", () => {
    const err = new AnalysisBelowThresholdError(1, 4, fakeReport());

    expect(err.scoredCount).toBe(1);
    expect(err.message).toContain("1");
  });
});
