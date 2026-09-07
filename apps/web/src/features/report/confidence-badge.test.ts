import { describe, expect, it } from "vitest";
import { confidenceBadgeLabel } from "./confidence-badge";
import { createTranslator } from "../../i18n";

const en = createTranslator("en");
const es = createTranslator("es");

describe("confidenceBadgeLabel", () => {
  it("labels a reduced-weight category (Performance, weightCap 0.5) as low confidence", () => {
    const label = confidenceBadgeLabel({ confidence: "estimated", weightCap: 0.5 }, en);
    expect(label).toBe("Low confidence — static estimate");
  });

  it("capitalizes 'estimated' confidence for a full-weight category (Testing)", () => {
    const label = confidenceBadgeLabel({ confidence: "estimated", weightCap: 1 }, en);
    expect(label).toBe("Estimated");
  });

  it("capitalizes 'measured' confidence for a full-weight category (Security)", () => {
    const label = confidenceBadgeLabel({ confidence: "measured", weightCap: 1 }, en);
    expect(label).toBe("Measured");
  });

  it("capitalizes 'judged' confidence for a full-weight category (Architecture)", () => {
    const label = confidenceBadgeLabel({ confidence: "judged", weightCap: 1 }, en);
    expect(label).toBe("Judged");
  });
});

describe("confidenceBadgeLabel — Spanish", () => {
  it("returns the Spanish low-confidence copy for a reduced-weight category", () => {
    expect(confidenceBadgeLabel({ confidence: "estimated", weightCap: 0.5 }, es)).toBe(
      "Confianza baja — estimación estática",
    );
  });

  it("returns the Spanish label for each confidence level of a full-weight category", () => {
    expect(confidenceBadgeLabel({ confidence: "measured", weightCap: 1 }, es)).toBe("Medido");
    expect(confidenceBadgeLabel({ confidence: "estimated", weightCap: 1 }, es)).toBe("Estimado");
    expect(confidenceBadgeLabel({ confidence: "judged", weightCap: 1 }, es)).toBe("Evaluado");
  });
});
