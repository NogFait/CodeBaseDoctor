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
 * Pure mapper from a problem+json body to a user-facing message. No
 * network/DOM access — trivially unit-testable, and reused by every
 * fetch-calling component (UrlEntryForm, RescanButton) as the single source
 * of truth for error copy instead of each duplicating a switch.
 */
export function formatProblemMessage(problem: ProblemDetails): string {
  switch (problem.type) {
    case "/errors/invalid-repo-url": {
      const repoUrl = typeof problem.repoUrl === "string" ? problem.repoUrl : undefined;
      return `That doesn't look like a valid GitHub repo URL${repoUrl ? `: "${repoUrl}"` : ""}.`;
    }
    case "/errors/repo-not-accessible":
      return problem.reason === "private"
        ? "This repo is private or we don't have access to it."
        : "We couldn't find that repo.";
    case "/errors/repo-too-large":
      return "This repo is too large to analyze right now.";
    case "/errors/quota-exceeded": {
      const remaining = typeof problem.remaining === "number" ? problem.remaining : 0;
      return `Daily analysis quota exceeded (${remaining} remaining). Try again later.`;
    }
    case "/errors/scan-timeout":
      return "The scan timed out. Please try again.";
    case "/errors/rate-limited":
      // Distinct from /errors/quota-exceeded's message on purpose — this is
      // the new head-call rate limiter (Fix C), a different concept from
      // the daily analysis quota: "you're submitting too fast", not "you're
      // out of free analyses for today".
      return "Too many attempts too quickly. Please wait a bit and try again.";
    default:
      return problem.title;
  }
}
