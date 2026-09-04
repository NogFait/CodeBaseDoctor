import { describe, expect, it } from "vitest";
import { InvalidRepoUrlError } from "@cbd/analysis";
import { parseCreateAnalysisDto } from "./create-analysis.dto";

describe("parseCreateAnalysisDto", () => {
  it("accepts a body with just a repoUrl string", () => {
    const dto = parseCreateAnalysisDto({ repoUrl: "https://github.com/nestjs/nest" });
    expect(dto).toEqual({ repoUrl: "https://github.com/nestjs/nest", forceRescan: false });
  });

  it("passes through forceRescan:true", () => {
    const dto = parseCreateAnalysisDto({ repoUrl: "https://github.com/nestjs/nest", forceRescan: true });
    expect(dto.forceRescan).toBe(true);
  });

  it("throws InvalidRepoUrlError when repoUrl is missing", () => {
    expect(() => parseCreateAnalysisDto({})).toThrow(InvalidRepoUrlError);
  });

  it("throws InvalidRepoUrlError when repoUrl is not a string", () => {
    expect(() => parseCreateAnalysisDto({ repoUrl: 12345 })).toThrow(InvalidRepoUrlError);
  });

  it("throws InvalidRepoUrlError when repoUrl is an empty string", () => {
    expect(() => parseCreateAnalysisDto({ repoUrl: "" })).toThrow(InvalidRepoUrlError);
  });

  it("throws InvalidRepoUrlError when the body itself is not an object", () => {
    expect(() => parseCreateAnalysisDto(null)).toThrow(InvalidRepoUrlError);
    expect(() => parseCreateAnalysisDto("nope")).toThrow(InvalidRepoUrlError);
  });
});
