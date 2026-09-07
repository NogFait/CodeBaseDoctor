import type { Messages } from "./es";

/**
 * English message catalogue. Typed as `Messages`, so omitting or misspelling
 * any key `es.ts` defines is a compile error. Copy here is kept verbatim to
 * the strings the components shipped with before i18n so the existing
 * English-asserting tests stay valid.
 */
export const en: Messages = {
  "switcher.label": "Language",

  "quota.remaining": "{n} analyses left today",

  "urlEntry.label": "GitHub repo URL",
  "urlEntry.submit": "Scan repo",
  "urlEntry.submitting": "Scanning…",

  "progress.ariaLabel": "Scan progress",
  "progress.heading": "Scanning repository…",
  "progress.starting": "Starting scan…",
  "progress.status.pending": "pending",
  "progress.status.running": "running",
  "progress.status.scored": "scored",
  "progress.status.failed": "failed",
  "progress.status.skipped": "skipped",

  "report.ariaLabelReport": "Scan report",
  "report.ariaLabelFailed": "Scan failed",
  "report.heading": "Report",
  "report.headingPartial": "Partial report",
  "report.compositeScore": "Composite score",
  "report.partialNotice": "Some categories could not be scored.",
  "report.categoryUnscored": "Could not be scored",
  "report.failedHeading": "Scan failed",
  "report.failedBody":
    "We couldn't complete this scan. Your quota was refunded — it doesn't count against your daily limit.",
  "report.rescan": "Re-scan",
  "report.rescanning": "Re-scanning…",
  "report.tryAgain": "Try again",
  "report.retry": "Retry",
  "report.analyzeAnother": "Analyze another repo",

  "confidence.lowStatic": "Low confidence — static estimate",
  "confidence.measured": "Measured",
  "confidence.estimated": "Estimated",
  "confidence.judged": "Judged",

  "category.architecture": "Architecture",
  "category.security": "Security",
  "category.testing": "Testing",
  "category.maintainability": "Maintainability",
  "category.performance": "Performance",
  "category.documentation": "Documentation",

  "problem.invalidRepoUrl": "That doesn't look like a valid GitHub repo URL.",
  "problem.invalidRepoUrlNamed": 'That doesn\'t look like a valid GitHub repo URL: "{repoUrl}".',
  "problem.repoNotAccessiblePrivate": "This repo is private or we don't have access to it.",
  "problem.repoNotAccessibleNotFound": "We couldn't find that repo.",
  "problem.repoTooLarge": "This repo is too large to analyze right now.",
  "problem.quotaExceeded": "Daily analysis quota exceeded ({remaining} remaining). Try again later.",
  "problem.scanTimeout": "The scan timed out. Please try again.",
  "problem.rateLimited": "Too many attempts too quickly. Please wait a bit and try again.",
  "problem.unknown": "Something went wrong. Please try again.",

  "error.generic": "Something went wrong. Please try again.",
};
