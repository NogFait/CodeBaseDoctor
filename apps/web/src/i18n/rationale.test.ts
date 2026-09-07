import { describe, expect, it } from "vitest";
import { createTranslator } from "./translator";
import { rationaleText, tCount } from "./rationale";
import type { CategoryScore } from "../api/types";

const en = createTranslator("en");
const es = createTranslator("es");

function cs(overrides: Partial<CategoryScore>): CategoryScore {
  return {
    category: "security",
    status: "scored",
    score: 80,
    confidence: "measured",
    weightCap: 1,
    rationale: "raw fallback text.",
    findings: [],
    durationMs: 10,
    ...overrides,
  };
}

describe("tCount", () => {
  it("picks .one for exactly 1 and .other otherwise", () => {
    expect(tCount(en, "rationale.security", 1, { n: 1 })).toBe("1 finding from Semgrep + OSV-Scanner.");
    expect(tCount(en, "rationale.security", 0, { n: 0 })).toBe("0 findings from Semgrep + OSV-Scanner.");
    expect(tCount(en, "rationale.security", 4, { n: 4 })).toBe("4 findings from Semgrep + OSV-Scanner.");
  });
});

describe("rationaleText — no rationaleKey (LLM categories)", () => {
  it("returns the raw rationale verbatim in both locales", () => {
    const cat = cs({ rationale: "Clean layering.", rationaleKey: undefined });
    expect(rationaleText(en, cat)).toBe("Clean layering.");
    expect(rationaleText(es, cat)).toBe("Clean layering.");
  });
});

describe("rationaleText — rationale.security", () => {
  const key = "rationale.security" as const;
  it("EN matches the current English exactly (singular + plural)", () => {
    expect(rationaleText(en, cs({ rationaleKey: key, rationaleParams: { n: 1 } }))).toBe(
      "1 finding from Semgrep + OSV-Scanner.",
    );
    expect(rationaleText(en, cs({ rationaleKey: key, rationaleParams: { n: 4 } }))).toBe(
      "4 findings from Semgrep + OSV-Scanner.",
    );
  });
  it("ES renders natural Spanish (singular + plural)", () => {
    expect(rationaleText(es, cs({ rationaleKey: key, rationaleParams: { n: 1 } }))).toBe(
      "1 hallazgo de Semgrep + OSV-Scanner.",
    );
    expect(rationaleText(es, cs({ rationaleKey: key, rationaleParams: { n: 4 } }))).toBe(
      "4 hallazgos de Semgrep + OSV-Scanner.",
    );
  });
});

describe("rationaleText — rationale.testing (ci boolean branch)", () => {
  const key = "rationale.testing" as const;
  it("EN matches the current English exactly for each ci branch", () => {
    expect(rationaleText(en, cs({ rationaleKey: key, rationaleParams: { n: 1, ci: true } }))).toBe(
      "1 test file detected by naming convention; CI config present.",
    );
    expect(rationaleText(en, cs({ rationaleKey: key, rationaleParams: { n: 2, ci: false } }))).toBe(
      "2 test files detected by naming convention; no CI config found.",
    );
  });
  it("ES composes the count and ci sub-keys", () => {
    expect(rationaleText(es, cs({ rationaleKey: key, rationaleParams: { n: 1, ci: true } }))).toBe(
      "1 archivo de test detectado por convención de nombres; hay configuración de CI.",
    );
    expect(rationaleText(es, cs({ rationaleKey: key, rationaleParams: { n: 2, ci: false } }))).toBe(
      "2 archivos de test detectados por convención de nombres; no se encontró configuración de CI.",
    );
  });
});

describe("rationaleText — rationale.maintainability (two nouns)", () => {
  const key = "rationale.maintainability" as const;
  it("EN matches the current English exactly; recognized noun is always plural", () => {
    expect(
      rationaleText(en, cs({ rationaleKey: key, rationaleParams: { oversized: 1, loc: 300, recognized: 5 } })),
    ).toBe("1 oversized file (>300 LOC) out of 5 recognized-language files.");
    expect(
      rationaleText(en, cs({ rationaleKey: key, rationaleParams: { oversized: 0, loc: 300, recognized: 3 } })),
    ).toBe("0 oversized files (>300 LOC) out of 3 recognized-language files.");
  });
  it("ES renders natural Spanish", () => {
    expect(
      rationaleText(es, cs({ rationaleKey: key, rationaleParams: { oversized: 1, loc: 300, recognized: 5 } })),
    ).toBe("1 archivo de gran tamaño (>300 LOC) de 5 archivos de lenguaje reconocido.");
    expect(
      rationaleText(es, cs({ rationaleKey: key, rationaleParams: { oversized: 2, loc: 300, recognized: 5 } })),
    ).toBe("2 archivos de gran tamaño (>300 LOC) de 5 archivos de lenguaje reconocido.");
  });
});

describe("rationaleText — rationale.performance (proper EN plural, was lazy 'file(s)')", () => {
  const key = "rationale.performance" as const;
  it("EN renders proper singular/plural", () => {
    expect(
      rationaleText(en, cs({ rationaleKey: key, rationaleParams: { files: 1, matches: 1 } })),
    ).toBe("Static heuristic scan over 1 file; 1 pattern match found. Weak signal — see weightCap.");
    expect(
      rationaleText(en, cs({ rationaleKey: key, rationaleParams: { files: 5, matches: 3 } })),
    ).toBe("Static heuristic scan over 5 files; 3 pattern matches found. Weak signal — see weightCap.");
  });
  it("ES renders natural Spanish", () => {
    expect(
      rationaleText(es, cs({ rationaleKey: key, rationaleParams: { files: 1, matches: 1 } })),
    ).toBe("Escaneo heurístico estático sobre 1 archivo; se encontró 1 coincidencia de patrón. Señal débil — ver weightCap.");
    expect(
      rationaleText(es, cs({ rationaleKey: key, rationaleParams: { files: 5, matches: 3 } })),
    ).toBe(
      "Escaneo heurístico estático sobre 5 archivos; se encontraron 3 coincidencias de patrón. Señal débil — ver weightCap.",
    );
  });
});
