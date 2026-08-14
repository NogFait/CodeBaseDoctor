import { describe, expect, it } from "vitest";
import {
  bytesToTmpfsSizeOpt,
  buildCloneArgs,
  buildLsRemoteArgs,
  buildLsTreeCountArgs,
  classifyCloneFailure,
  classifyLsRemoteFailure,
} from "./git-commands";

describe("buildCloneArgs", () => {
  it("disables hooks and the file protocol, and applies the blob-size filter", () => {
    const args = buildCloneArgs("https://github.com/nestjs/nest", "/work");

    expect(args).toEqual([
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.file.allow=never",
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--filter=blob:limit=1m",
      "--no-tags",
      "https://github.com/nestjs/nest",
      "/work",
    ]);
  });

  it("carries the exact url and destination through untouched for a different repo", () => {
    const args = buildCloneArgs("git://172.17.0.1:9418/fixture", "/dest");

    expect(args).toContain("git://172.17.0.1:9418/fixture");
    expect(args).toContain("/dest");
    expect(args[args.length - 1]).toBe("/dest");
    expect(args[args.length - 2]).toBe("git://172.17.0.1:9418/fixture");
  });
});

describe("buildLsRemoteArgs", () => {
  it("checks HEAD only, with the file protocol still disabled", () => {
    expect(buildLsRemoteArgs("https://github.com/nestjs/nest")).toEqual([
      "-c",
      "protocol.file.allow=never",
      "ls-remote",
      "--exit-code",
      "https://github.com/nestjs/nest",
      "HEAD",
    ]);
  });
});

describe("buildLsTreeCountArgs", () => {
  it("lists tracked file names at HEAD, recursively, for the file-count gate", () => {
    expect(buildLsTreeCountArgs("/work/repo")).toEqual([
      "-C",
      "/work/repo",
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
    ]);
  });

  it("targets whatever directory it is given, not a hardcoded path", () => {
    expect(buildLsTreeCountArgs("/other/dir")).toContain("/other/dir");
  });
});

describe("classifyCloneFailure", () => {
  it("classifies ENOSPC / no-space stderr as too-large", () => {
    expect(classifyCloneFailure("fatal: write error: No space left on device")).toBe("too-large");
    expect(classifyCloneFailure("error: ENOSPC: no space left on device, write")).toBe("too-large");
  });

  it("classifies auth/not-found stderr as not-accessible", () => {
    expect(
      classifyCloneFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
    ).toBe("not-accessible");
    expect(classifyCloneFailure("remote: Repository not found.")).toBe("not-accessible");
    expect(classifyCloneFailure("fatal: Authentication failed for 'https://github.com/x/y/'")).toBe(
      "not-accessible",
    );
  });

  it("classifies anything else as other", () => {
    expect(classifyCloneFailure("fatal: some unrelated network blip")).toBe("other");
  });
});

describe("classifyLsRemoteFailure", () => {
  it("classifies connection-refused / repository-not-found as not-accessible", () => {
    expect(classifyLsRemoteFailure("fatal: unable to connect to 172.17.0.1: 172.17.0.1: Connection refused")).toBe(
      "not-accessible",
    );
    expect(classifyLsRemoteFailure("remote: Repository not found.")).toBe("not-accessible");
  });

  it("classifies anything else as other", () => {
    expect(classifyLsRemoteFailure("fatal: some unrelated network blip")).toBe("other");
  });
});

describe("bytesToTmpfsSizeOpt", () => {
  it("rounds up to the nearest whole megabyte and formats as tmpfs size= value", () => {
    expect(bytesToTmpfsSizeOpt(2 * 1024 * 1024)).toBe("2m");
    expect(bytesToTmpfsSizeOpt(2 * 1024 * 1024 + 1)).toBe("3m");
  });

  it("never returns less than 1m even for a sub-megabyte cap", () => {
    expect(bytesToTmpfsSizeOpt(100)).toBe("1m");
  });
});
