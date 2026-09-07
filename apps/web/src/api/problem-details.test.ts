import { describe, expect, it } from "vitest";
import { formatProblemMessage } from "./problem-details";
import { createTranslator } from "../i18n";

const en = createTranslator("en");
const es = createTranslator("es");

describe("formatProblemMessage", () => {
  it("maps invalid-repo-url to a message naming the bad URL", () => {
    const message = formatProblemMessage(
      {
        type: "/errors/invalid-repo-url",
        title: "Invalid or unsupported repo URL",
        repoUrl: "not-a-url",
      },
      en,
    );
    expect(message).toBe('That doesn\'t look like a valid GitHub repo URL: "not-a-url".');
  });

  it("maps repo-not-accessible with reason=private to a private-repo message", () => {
    const message = formatProblemMessage(
      {
        type: "/errors/repo-not-accessible",
        title: "Repo not accessible",
        reason: "private",
      },
      en,
    );
    expect(message).toBe("This repo is private or we don't have access to it.");
  });

  it("maps repo-not-accessible with reason=not-found to a not-found message", () => {
    const message = formatProblemMessage(
      {
        type: "/errors/repo-not-accessible",
        title: "Repo not accessible",
        reason: "not-found",
      },
      en,
    );
    expect(message).toBe("We couldn't find that repo.");
  });

  it("maps quota-exceeded to a message including the remaining count", () => {
    const message = formatProblemMessage(
      {
        type: "/errors/quota-exceeded",
        title: "Daily analysis quota exceeded",
        limit: 5,
        remaining: 0,
        resetsAt: "2026-09-07T00:00:00.000Z",
      },
      en,
    );
    expect(message).toBe("Daily analysis quota exceeded (0 remaining). Try again later.");
  });

  it("maps repo-too-large to a size-limit message", () => {
    const message = formatProblemMessage(
      {
        type: "/errors/repo-too-large",
        title: "Repo exceeds ingestion size limits",
      },
      en,
    );
    expect(message).toBe("This repo is too large to analyze right now.");
  });

  it("maps scan-timeout to a timeout message", () => {
    const message = formatProblemMessage(
      {
        type: "/errors/scan-timeout",
        title: "Scan timed out",
      },
      en,
    );
    expect(message).toBe("The scan timed out. Please try again.");
  });

  it("maps rate-limited (Fix C's new head-call rate limiter) to a distinct, clear retry-later message", () => {
    const message = formatProblemMessage(
      {
        type: "/errors/rate-limited",
        title: "Too many repo-lookup attempts",
        limit: 20,
        resetsAt: "2026-09-07T00:00:00.000Z",
      },
      en,
    );
    expect(message).toBe("Too many attempts too quickly. Please wait a bit and try again.");
    // Must be distinct from the daily-quota message — different concept.
    expect(message).not.toContain("Daily analysis quota");
  });

  it("falls back to the problem's own title for an unrecognized type", () => {
    const message = formatProblemMessage(
      {
        type: "/errors/something-unmapped",
        title: "Something specific went wrong",
      },
      en,
    );
    expect(message).toBe("Something specific went wrong");
  });
});

describe("formatProblemMessage — Spanish", () => {
  it("maps invalid-repo-url (named) to the Spanish copy with the bad URL", () => {
    expect(
      formatProblemMessage(
        { type: "/errors/invalid-repo-url", title: "Invalid", repoUrl: "not-a-url" },
        es,
      ),
    ).toBe('Eso no parece una URL válida de repo de GitHub: "not-a-url".');
  });

  it("maps invalid-repo-url (no URL) to the plain Spanish copy", () => {
    expect(formatProblemMessage({ type: "/errors/invalid-repo-url", title: "Invalid" }, es)).toBe(
      "Eso no parece una URL válida de repo de GitHub.",
    );
  });

  it("maps repo-not-accessible private/not-found to Spanish copy", () => {
    expect(
      formatProblemMessage(
        { type: "/errors/repo-not-accessible", title: "x", reason: "private" },
        es,
      ),
    ).toBe("Este repo es privado o no tenemos acceso.");
    expect(
      formatProblemMessage(
        { type: "/errors/repo-not-accessible", title: "x", reason: "not-found" },
        es,
      ),
    ).toBe("No pudimos encontrar ese repo.");
  });

  it("maps quota-exceeded to Spanish copy interpolating the remaining count", () => {
    expect(
      formatProblemMessage(
        { type: "/errors/quota-exceeded", title: "x", remaining: 2 },
        es,
      ),
    ).toBe("Cuota diaria de análisis superada (2 restantes). Probá más tarde.");
  });

  it("maps scan-timeout and rate-limited to Spanish copy", () => {
    expect(formatProblemMessage({ type: "/errors/scan-timeout", title: "x" }, es)).toBe(
      "El análisis expiró. Probá de nuevo.",
    );
    expect(formatProblemMessage({ type: "/errors/rate-limited", title: "x" }, es)).toBe(
      "Demasiados intentos muy rápido. Esperá un momento y probá de nuevo.",
    );
  });
});
