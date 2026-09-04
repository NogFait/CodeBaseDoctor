import { describe, expect, it } from "vitest";
import type { CategoryId, CategoryScore } from "../domain";
import { ScoreAggregator, type AggregateRepoMeta } from "./score-aggregator";

function scoredCategory(category: CategoryId, score: number, weightCap = 1): CategoryScore {
  return {
    category,
    status: "scored",
    score,
    confidence: "measured",
    weightCap,
    rationale: `${category} scored`,
    findings: [],
    durationMs: 10,
  };
}

function failedCategory(category: CategoryId): CategoryScore {
  return {
    category,
    status: "failed",
    score: null,
    confidence: "measured",
    weightCap: 1,
    rationale: `${category} could not be scored`,
    findings: [],
    error: { code: "BOOM", message: "boom" },
    durationMs: 5,
  };
}

const ALL_CATEGORIES: CategoryId[] = [
  "architecture",
  "security",
  "testing",
  "maintainability",
  "performance",
  "documentation",
];

const META: AggregateRepoMeta = {
  repoUrl: "https://github.com/acme/widget",
  commitSha: "a".repeat(40),
  engineVersion: "1.0.0",
  dominantLanguage: "TypeScript",
  languageMix: [{ language: "TypeScript", loc: 100, share: 1 }],
};

describe("ScoreAggregator", () => {
  it("reports status 'complete' and completeness 1 when all 6 categories scored", () => {
    const categories = ALL_CATEGORIES.map((c) => scoredCategory(c, 80));
    const aggregator = new ScoreAggregator();

    const report = aggregator.aggregate(categories, META);

    expect(report.status).toBe("complete");
    expect(report.completeness).toBe(1);
    expect(report.categories).toBe(categories);
    expect(report.categories).toHaveLength(6);
  });

  it("reports status 'partial' (never 'complete') when 5 of 6 categories scored", () => {
    const categories = [
      ...ALL_CATEGORIES.slice(0, 5).map((c) => scoredCategory(c, 70)),
      failedCategory(ALL_CATEGORIES[5]),
    ];
    const aggregator = new ScoreAggregator();

    const report = aggregator.aggregate(categories, META);

    expect(report.status).toBe("partial");
    expect(report.completeness).toBeCloseTo(5 / 6);
  });

  it("reports status 'partial' (never 'complete') when exactly 4 of 6 categories scored", () => {
    const categories = [
      ...ALL_CATEGORIES.slice(0, 4).map((c) => scoredCategory(c, 70)),
      ...ALL_CATEGORIES.slice(4).map((c) => failedCategory(c)),
    ];
    const aggregator = new ScoreAggregator();

    const report = aggregator.aggregate(categories, META);

    expect(report.status).toBe("partial");
    expect(report.completeness).toBeCloseTo(4 / 6);
  });

  it("compositeScore is null and completeness 0 when zero categories scored", () => {
    const categories = ALL_CATEGORIES.map((c) => failedCategory(c));
    const aggregator = new ScoreAggregator();

    const report = aggregator.aggregate(categories, META);

    expect(report.status).toBe("partial");
    expect(report.compositeScore).toBeNull();
    expect(report.completeness).toBe(0);
  });

  it("weights a weightCap:0.5 category (Performance) at HALF a weightCap:1.0 category in the composite mean", () => {
    // architecture: weightCap 1.0, score 80 -> contributes 80 * 1.0 = 80, weight 1.0
    // performance:  weightCap 0.5, score 60 -> contributes 60 * 0.5 = 30, weight 0.5
    // composite = (80 + 30) / (1.0 + 0.5) = 110 / 1.5 = 73.333...
    // An equal-weight mean of 80 and 60 would be 70 — the actual result sits
    // closer to Architecture's 80, proving Performance's pull was halved.
    const categories: CategoryScore[] = [
      scoredCategory("architecture", 80, 1),
      scoredCategory("performance", 60, 0.5),
    ];
    const aggregator = new ScoreAggregator();

    const report = aggregator.aggregate(categories, META);

    expect(report.compositeScore).toBeCloseTo(73.333, 2);
    expect(report.compositeScore).not.toBeCloseTo(70, 2);
  });

  it("preserves category order exactly as given (order-stable)", () => {
    const categories = [
      scoredCategory("performance", 10),
      scoredCategory("security", 20),
      scoredCategory("architecture", 30),
    ];
    const aggregator = new ScoreAggregator();

    const report = aggregator.aggregate(categories, META);

    expect(report.categories.map((c) => c.category)).toEqual(["performance", "security", "architecture"]);
  });

  it("uses the injected clock for createdAt (deterministic, no real Date.now in tests)", () => {
    const fixed = new Date("2026-03-01T12:00:00Z");
    const aggregator = new ScoreAggregator(() => fixed);

    const report = aggregator.aggregate([scoredCategory("security", 90)], META);

    expect(report.createdAt).toBe(fixed);
  });

  it("passes repo metadata through untouched", () => {
    const aggregator = new ScoreAggregator();

    const report = aggregator.aggregate([scoredCategory("security", 90)], META);

    expect(report.repoUrl).toBe(META.repoUrl);
    expect(report.commitSha).toBe(META.commitSha);
    expect(report.engineVersion).toBe(META.engineVersion);
    expect(report.dominantLanguage).toBe(META.dominantLanguage);
    expect(report.languageMix).toBe(META.languageMix);
  });
});
