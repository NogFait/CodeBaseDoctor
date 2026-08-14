export interface QuotaDecision {
  allowed: boolean;
  tier: "free" | "paid";
  limit: number;
  remaining: number;
  resetsAt: Date;
}

/**
 * Port 5 — quota. Policy (limit values, tiering) lives in the adapter, never
 * in the use case. See design: "The five ports".
 */
export interface UsageQuotaPort {
  peek(actorId: string): Promise<QuotaDecision>;
  /** Idempotent by reservationId. Throws QuotaExceededError over the limit. */
  consume(actorId: string, reservationId: string): Promise<QuotaDecision>;
  /** No-op if already refunded. */
  refund(reservationId: string): Promise<void>;
}
