// Domain-level errors. Pure TypeScript, thrown by RepoContext implementations
// (and anything else operating purely within the domain).

import type { RepoScoreReport } from "./types";

export class FileTooLargeError extends Error {
  constructor(
    public readonly path: string,
    public readonly sizeBytes: number,
    public readonly maxBytes: number,
  ) {
    super(`File "${path}" is ${sizeBytes} bytes, exceeding the ${maxBytes}-byte read limit`);
    this.name = "FileTooLargeError";
  }
}

/**
 * Thrown by `RepoAnalysisService` when fewer than the minimum required
 * categories reached `status:'scored'`. Per design decision #6 / spec
 * `analysis-orchestration`: below this threshold, no `RepoScan` is
 * persisted and the quota reservation is refunded — this error is the
 * distinguishable signal the (future) API/worker layer maps onto a
 * `job.status='failed'` response, analogous to how `QuotaExceededError`
 * is what maps onto HTTP 429.
 */
export class AnalysisBelowThresholdError extends Error {
  constructor(
    public readonly scoredCount: number,
    public readonly minimumRequired: number,
    public readonly report: RepoScoreReport,
  ) {
    super(
      `Only ${scoredCount} of ${report.categories.length} categories were scored ` +
        `(minimum ${minimumRequired} required) — the scan was not persisted and the quota reservation was refunded.`,
    );
    this.name = "AnalysisBelowThresholdError";
  }
}
