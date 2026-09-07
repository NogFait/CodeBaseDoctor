import { describe, expect, it } from "vitest";
import { formatProblemMessage } from "./problem-details";

describe("formatProblemMessage", () => {
  it("maps invalid-repo-url to a message naming the bad URL", () => {
    const message = formatProblemMessage({
      type: "/errors/invalid-repo-url",
      title: "Invalid or unsupported repo URL",
      repoUrl: "not-a-url",
    });
    expect(message).toBe('That doesn\'t look like a valid GitHub repo URL: "not-a-url".');
  });

  it("maps repo-not-accessible with reason=private to a private-repo message", () => {
    const message = formatProblemMessage({
      type: "/errors/repo-not-accessible",
      title: "Repo not accessible",
      reason: "private",
    });
    expect(message).toBe("This repo is private or we don't have access to it.");
  });

  it("maps repo-not-accessible with reason=not-found to a not-found message", () => {
    const message = formatProblemMessage({
      type: "/errors/repo-not-accessible",
      title: "Repo not accessible",
      reason: "not-found",
    });
    expect(message).toBe("We couldn't find that repo.");
  });

  it("maps quota-exceeded to a message including the remaining count", () => {
    const message = formatProblemMessage({
      type: "/errors/quota-exceeded",
      title: "Daily analysis quota exceeded",
      limit: 5,
      remaining: 0,
      resetsAt: "2026-09-07T00:00:00.000Z",
    });
    expect(message).toBe("Daily analysis quota exceeded (0 remaining). Try again later.");
  });

  it("maps repo-too-large to a size-limit message", () => {
    const message = formatProblemMessage({
      type: "/errors/repo-too-large",
      title: "Repo exceeds ingestion size limits",
    });
    expect(message).toBe("This repo is too large to analyze right now.");
  });

  it("maps scan-timeout to a timeout message", () => {
    const message = formatProblemMessage({
      type: "/errors/scan-timeout",
      title: "Scan timed out",
    });
    expect(message).toBe("The scan timed out. Please try again.");
  });

  it("maps rate-limited (Fix C's new head-call rate limiter) to a distinct, clear retry-later message", () => {
    const message = formatProblemMessage({
      type: "/errors/rate-limited",
      title: "Too many repo-lookup attempts",
      limit: 20,
      resetsAt: "2026-09-07T00:00:00.000Z",
    });
    expect(message).toBe("Too many attempts too quickly. Please wait a bit and try again.");
    // Must be distinct from the daily-quota message — different concept.
    expect(message).not.toContain("Daily analysis quota");
  });

  it("falls back to the problem's own title for an unrecognized type", () => {
    const message = formatProblemMessage({
      type: "/errors/something-unmapped",
      title: "Something specific went wrong",
    });
    expect(message).toBe("Something specific went wrong");
  });
});
