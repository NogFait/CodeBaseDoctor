import { describe, expect, it } from "vitest";
import { InvalidRepoUrlError } from "@cbd/analysis";
import { parseGithubRepoUrl } from "./repo-url";

describe("parseGithubRepoUrl", () => {
  it("parses a well-formed https github URL into a RepoRef", () => {
    const ref = parseGithubRepoUrl("https://github.com/nestjs/nest");

    expect(ref).toEqual({
      host: "github",
      owner: "nestjs",
      repo: "nest",
      url: "https://github.com/nestjs/nest",
    });
  });

  it("strips a trailing .git suffix from the repo name", () => {
    const ref = parseGithubRepoUrl("https://github.com/nestjs/nest.git");

    expect(ref.repo).toBe("nest");
  });

  it("throws InvalidRepoUrlError for a non-github host", () => {
    expect(() => parseGithubRepoUrl("https://gitlab.com/nestjs/nest")).toThrow(InvalidRepoUrlError);
  });

  it("throws InvalidRepoUrlError for a URL missing the repo path segment", () => {
    expect(() => parseGithubRepoUrl("https://github.com/nestjs")).toThrow(InvalidRepoUrlError);
  });

  it("throws InvalidRepoUrlError for a string that is not a URL at all", () => {
    expect(() => parseGithubRepoUrl("not a url")).toThrow(InvalidRepoUrlError);
  });
});
