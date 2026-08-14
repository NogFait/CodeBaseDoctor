import { QuotaExceededError, type QuotaDecision, type UsageQuotaPort } from "@cbd/analysis";

export interface InMemoryQuotaOptions {
  limit?: number;
  tier?: "free" | "paid";
  resetsAt?: Date;
}

interface Reservation {
  actorId: string;
  state: "consumed" | "refunded";
}

/**
 * In-memory UsageQuotaPort test double. Configurable daily `limit`; tracks
 * every consume/refund call so a test can assert e.g. "cache hit consumed
 * nothing" by inspecting `consumeCalls`. `refund()` is idempotent — a
 * second refund on the same reservationId is a no-op.
 */
export class InMemoryQuota implements UsageQuotaPort {
  private readonly limit: number;
  private readonly tier: "free" | "paid";
  private readonly resetsAt: Date;
  private readonly reservations = new Map<string, Reservation>();

  readonly consumeCalls: { actorId: string; reservationId: string }[] = [];
  readonly refundCalls: string[] = [];

  constructor(options: InMemoryQuotaOptions = {}) {
    this.limit = options.limit ?? 5;
    this.tier = options.tier ?? "free";
    this.resetsAt = options.resetsAt ?? new Date("2099-01-01T00:00:00Z");
  }

  private consumedCountFor(actorId: string): number {
    let count = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.actorId === actorId && reservation.state === "consumed") count++;
    }
    return count;
  }

  async peek(actorId: string): Promise<QuotaDecision> {
    const remaining = Math.max(this.limit - this.consumedCountFor(actorId), 0);
    return { allowed: remaining > 0, tier: this.tier, limit: this.limit, remaining, resetsAt: this.resetsAt };
  }

  async consume(actorId: string, reservationId: string): Promise<QuotaDecision> {
    this.consumeCalls.push({ actorId, reservationId });

    const existing = this.reservations.get(reservationId);
    if (existing) {
      // Idempotent: the same reservationId consuming again must not double-count.
      const remaining = Math.max(this.limit - this.consumedCountFor(actorId), 0);
      return { allowed: true, tier: this.tier, limit: this.limit, remaining, resetsAt: this.resetsAt };
    }

    const usedBefore = this.consumedCountFor(actorId);
    if (usedBefore >= this.limit) {
      throw new QuotaExceededError(actorId, this.limit, this.resetsAt);
    }

    this.reservations.set(reservationId, { actorId, state: "consumed" });
    const remaining = Math.max(this.limit - (usedBefore + 1), 0);
    return { allowed: true, tier: this.tier, limit: this.limit, remaining, resetsAt: this.resetsAt };
  }

  async refund(reservationId: string): Promise<void> {
    this.refundCalls.push(reservationId);

    const existing = this.reservations.get(reservationId);
    if (!existing || existing.state === "refunded") {
      return; // idempotent no-op
    }
    existing.state = "refunded";
  }
}
