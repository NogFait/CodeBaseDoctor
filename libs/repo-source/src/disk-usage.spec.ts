import { describe, expect, it } from "vitest";
import { buildDuArgs, parseDuOutputKb } from "./disk-usage";

describe("buildDuArgs", () => {
  it("summarizes disk usage in KB for the given mount path", () => {
    expect(buildDuArgs("/work")).toEqual(["-s", "-k", "/work"]);
  });
});

describe("parseDuOutputKb", () => {
  it("parses the leading KB number from du -sk output", () => {
    expect(parseDuOutputKb("2048\t/work\n")).toBe(2048);
  });

  it("parses correctly even with extra whitespace", () => {
    expect(parseDuOutputKb("  512   /work\n")).toBe(512);
  });

  it("throws a descriptive error for unparsable output", () => {
    expect(() => parseDuOutputKb("garbage output")).toThrow(/could not parse du output/);
  });
});
