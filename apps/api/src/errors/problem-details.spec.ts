import { NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  InvalidRepoUrlError,
  QuotaExceededError,
  RepoNotAccessibleError,
  RepoTooLargeError,
} from "@cbd/analysis";
import { mapErrorToProblem } from "./problem-details";

describe("mapErrorToProblem", () => {
  it("maps InvalidRepoUrlError to 400 /errors/invalid-repo-url with the offending repoUrl", () => {
    const mapped = mapErrorToProblem(new InvalidRepoUrlError("ftp://not-github.example"));
    expect(mapped.status).toBe(400);
    expect(mapped.type).toBe("/errors/invalid-repo-url");
    expect(mapped.extra).toMatchObject({ repoUrl: "ftp://not-github.example" });
  });

  it("maps RepoNotAccessibleError to 422 /errors/repo-not-accessible with repoUrl and reason", () => {
    const mapped = mapErrorToProblem(new RepoNotAccessibleError("https://github.com/o/r", "private"));
    expect(mapped.status).toBe(422);
    expect(mapped.type).toBe("/errors/repo-not-accessible");
    expect(mapped.extra).toMatchObject({ repoUrl: "https://github.com/o/r", reason: "private" });
  });

  it("maps RepoTooLargeError to 422 /errors/repo-too-large with limits and actual", () => {
    const mapped = mapErrorToProblem(
      new RepoTooLargeError({ maxBytes: 500_000_000, maxFiles: 50_000 }, { sizeKb: 900_000 }),
    );
    expect(mapped.status).toBe(422);
    expect(mapped.type).toBe("/errors/repo-too-large");
    expect(mapped.extra).toMatchObject({
      limits: { maxBytes: 500_000_000, maxFiles: 50_000 },
      actual: { sizeKb: 900_000 },
    });
  });

  it("maps QuotaExceededError to 429 /errors/quota-exceeded with limit/remaining/resetsAt/upgradeUrl and a Retry-After header", () => {
    const resetsAt = new Date(Date.now() + 3600_000);
    const mapped = mapErrorToProblem(new QuotaExceededError("actor-1", 5, resetsAt));
    expect(mapped.status).toBe(429);
    expect(mapped.type).toBe("/errors/quota-exceeded");
    expect(mapped.extra).toMatchObject({ limit: 5, remaining: 0 });
    expect(mapped.extra?.resetsAt).toBe(resetsAt.toISOString());
    expect(typeof mapped.extra?.upgradeUrl).toBe("string");
    expect(mapped.headers?.["Retry-After"]).toBeDefined();
    const retryAfterSeconds = Number(mapped.headers?.["Retry-After"]);
    expect(retryAfterSeconds).toBeGreaterThan(3500);
    expect(retryAfterSeconds).toBeLessThanOrEqual(3600);
  });

  it("clamps Retry-After to 0 for an already-past resetsAt (never a negative header value)", () => {
    const mapped = mapErrorToProblem(new QuotaExceededError("actor-1", 5, new Date(Date.now() - 1000)));
    expect(mapped.headers?.["Retry-After"]).toBe("0");
  });

  it("maps a Nest HttpException (e.g. NotFoundException) to its own status, not a flat 500", () => {
    const mapped = mapErrorToProblem(new NotFoundException());
    expect(mapped.status).toBe(404);
  });

  it("maps an unrecognized error to a generic 500 problem, not a crash", () => {
    const mapped = mapErrorToProblem(new Error("something unexpected"));
    expect(mapped.status).toBe(500);
    expect(mapped.type).toBe("about:blank");
  });
});
