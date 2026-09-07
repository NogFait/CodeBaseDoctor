import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "./translator";
import type { Messages } from "./messages/es";

describe("createTranslator", () => {
  it("returns the Spanish string for a key when locale is 'es'", () => {
    const t = createTranslator("es");
    expect(t("urlEntry.submit")).toBe("Analizar repo");
  });

  it("returns the English string for a key when locale is 'en'", () => {
    const t = createTranslator("en");
    expect(t("urlEntry.submit")).toBe("Scan repo");
  });

  it("interpolates {placeholder} params per locale", () => {
    expect(createTranslator("en")("quota.remaining", { n: 4 })).toBe("4 analyses left today");
    expect(createTranslator("es")("quota.remaining", { n: 4 })).toBe("4 análisis restantes hoy");
  });

  it("interpolates a named placeholder in a problem message", () => {
    expect(createTranslator("en")("problem.quotaExceeded", { remaining: 0 })).toBe(
      "Daily analysis quota exceeded (0 remaining). Try again later.",
    );
  });

  it("returns the key itself for a missing key (and warns in dev)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = createTranslator("en");
    expect(t("does.not.exist" as keyof Messages)).toBe("does.not.exist");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("leaves an unknown placeholder untouched when no matching param is given", () => {
    expect(createTranslator("en")("quota.remaining")).toBe("{n} analyses left today");
  });
});
