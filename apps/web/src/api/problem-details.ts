import type { TFunction } from "../i18n";

/**
 * RFC 9457 `application/problem+json` body, as returned by `apps/api`'s
 * `ProblemDetailsFilter` (see apps/api/src/errors/problem-details.ts). Only
 * `type`/`title` are guaranteed; every other member is error-type-specific
 * ("extra" on the backend side), hence the index signature.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status?: number;
  [key: string]: unknown;
}

/**
 * Pure mapper from a problem+json body to a user-facing, localized message.
 * No network/DOM access — trivially unit-testable, and reused by every
 * fetch-calling component (UrlEntryForm, RescanButton via
 * `use-submit-analysis`; ProgressView/ReportView on a poll-time failure) as
 * the single source of truth for error copy instead of each duplicating a
 * switch.
 *
 * Takes the translator as an argument rather than being a hook — its
 * callers already hold a `useT()` `t` and some (the submit hook) are
 * themselves not components.
 */
export function formatProblemMessage(problem: ProblemDetails, t: TFunction): string {
  switch (problem.type) {
    case "/errors/invalid-repo-url": {
      const repoUrl = typeof problem.repoUrl === "string" ? problem.repoUrl : undefined;
      return repoUrl
        ? t("problem.invalidRepoUrlNamed", { repoUrl })
        : t("problem.invalidRepoUrl");
    }
    case "/errors/repo-not-accessible":
      return problem.reason === "private"
        ? t("problem.repoNotAccessiblePrivate")
        : t("problem.repoNotAccessibleNotFound");
    case "/errors/repo-too-large":
      return t("problem.repoTooLarge");
    case "/errors/quota-exceeded": {
      const remaining = typeof problem.remaining === "number" ? problem.remaining : 0;
      return t("problem.quotaExceeded", { remaining });
    }
    case "/errors/scan-timeout":
      return t("problem.scanTimeout");
    case "/errors/rate-limited":
      // Distinct from /errors/quota-exceeded's message on purpose — this is
      // the new head-call rate limiter (Fix C), a different concept from
      // the daily analysis quota: "you're submitting too fast", not "you're
      // out of free analyses for today".
      return t("problem.rateLimited");
    default:
      // Prefer the server's own specific title; only fall back to generic
      // copy if it somehow arrived empty.
      return problem.title || t("problem.unknown");
  }
}
