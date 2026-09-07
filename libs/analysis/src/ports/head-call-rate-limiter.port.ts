/**
 * A NEW, independent gate on how often a given actor can trigger
 * `RepoSourcePort.head()` — the expensive step (spins a real Docker
 * container, `git ls-remote` via the `cbd-fetcher` image) that
 * `SubmitAnalysisUseCase.submit()` calls BEFORE `UsageQuotaPort.consume()`
 * is ever reached (see that use case's own doc comment: `resolve()` is
 * cheap/pure, `head()` is not, and quota is only consumed after a
 * cache-miss check that itself depends on `head()`'s result).
 *
 * Deliberately NOT `UsageQuotaPort`: no refund/idempotency semantics here,
 * no daily reset, no per-actor billing ledger — just "has this actor made
 * too many `head()` attempts in the current window". A disposable,
 * high-frequency counter, not a quota reservation. Policy (limit/window
 * values) lives in the adapter, same convention `UsageQuotaPort` documents
 * ("Policy ... lives in the adapter, never in the use case").
 */
export interface HeadCallRateLimiterPort {
  /**
   * Throws `HeadCallRateLimitExceededError` if `actorId` is already at or
   * over the limit for the current window; otherwise records this attempt
   * (counts toward the limit) and resolves.
   */
  checkAndRecord(actorId: string): Promise<void>;
}
