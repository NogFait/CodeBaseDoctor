import { describe, expect, it } from "vitest";
import {
  CloneTimeoutError,
  InvalidRepoUrlError,
  QuotaExceededError,
  RepoNotAccessibleError,
  RepoTooLargeError,
  TooManyFilesError,
} from "./errors";

describe("port error classes", () => {
  it("InvalidRepoUrlError carries the rejected url", () => {
    const err = new InvalidRepoUrlError("not-a-url");
    expect(err.name).toBe("InvalidRepoUrlError");
    expect(err.url).toBe("not-a-url");
  });

  it("RepoNotAccessibleError distinguishes private from not-found without leaking which", () => {
    const priv = new RepoNotAccessibleError("https://github.com/acme/secret", "private");
    const missing = new RepoNotAccessibleError("https://github.com/acme/ghost", "not-found");

    expect(priv.reason).toBe("private");
    expect(missing.reason).toBe("not-found");
    expect(priv.url).toBe("https://github.com/acme/secret");
  });

  it("RepoTooLargeError carries limits and actual figures", () => {
    const err = new RepoTooLargeError({ maxBytes: 500_000_000, maxFiles: 50_000 }, { sizeKb: 900_000 });
    expect(err.limits).toEqual({ maxBytes: 500_000_000, maxFiles: 50_000 });
    expect(err.actual).toEqual({ sizeKb: 900_000 });
  });

  it("TooManyFilesError message reflects both the limit and the actual count", () => {
    const err = new TooManyFilesError(50_000, 62_318);
    expect(err.maxFiles).toBe(50_000);
    expect(err.actualFiles).toBe(62_318);
    expect(err.message).toContain("50000");
    expect(err.message).toContain("62318");
  });

  it("CloneTimeoutError carries the configured timeout", () => {
    const err = new CloneTimeoutError(120_000);
    expect(err.timeoutMs).toBe(120_000);
  });

  it("QuotaExceededError carries actor, limit, and reset time", () => {
    const resetsAt = new Date("2026-08-15T00:00:00Z");
    const err = new QuotaExceededError("actor-123", 5, resetsAt);
    expect(err.actorId).toBe("actor-123");
    expect(err.limit).toBe(5);
    expect(err.resetsAt).toBe(resetsAt);
  });
});
