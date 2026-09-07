import { describe, expect, it } from "vitest";
import { confidenceBadgeLabel } from "./confidence-badge";

describe("confidenceBadgeLabel", () => {
  it("labels a reduced-weight category (Performance, weightCap 0.5) as low confidence", () => {
    const label = confidenceBadgeLabel({ confidence: "estimated", weightCap: 0.5 });
    expect(label).toBe("Low confidence — static estimate");
  });

  it("capitalizes 'estimated' confidence for a full-weight category (Testing)", () => {
    const label = confidenceBadgeLabel({ confidence: "estimated", weightCap: 1 });
    expect(label).toBe("Estimated");
  });

  it("capitalizes 'measured' confidence for a full-weight category (Security)", () => {
    const label = confidenceBadgeLabel({ confidence: "measured", weightCap: 1 });
    expect(label).toBe("Measured");
  });

  it("capitalizes 'judged' confidence for a full-weight category (Architecture)", () => {
    const label = confidenceBadgeLabel({ confidence: "judged", weightCap: 1 });
    expect(label).toBe("Judged");
  });
});
