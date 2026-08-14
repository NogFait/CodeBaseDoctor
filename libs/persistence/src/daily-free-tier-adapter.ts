import { PrismaClient, Prisma } from "@prisma/client";
import { QuotaExceededError, type QuotaDecision, type UsageQuotaPort } from "@cbd/analysis";

export interface DailyFreeTierAdapterOptions {
  /** Free-tier daily limit per actor. Design's Open Questions flags this as an adapter constant. */
  limit?: number;
}

/**
 * DailyFreeTierAdapter — UsageQuotaPort implementation. See design's exact
 * transaction shape ("DailyFreeTierAdapter.consume() runs in one
 * transaction"):
 *   SELECT pg_advisory_xact_lock(hashtext($actorId))
 *   -> COUNT(*) WHERE actor_id AND usage_date=CURRENT_DATE AND state='consumed'
 *   -> if >= limit throw QuotaExceededError
 *   -> else INSERT ... ON CONFLICT (id) DO NOTHING
 *
 * The advisory lock (not a unique constraint) is what makes the
 * check-then-insert race-free across concurrent reservations for the SAME
 * actor — see the concurrency test in the integration spec.
 *
 * Idempotency deviation worth flagging explicitly: a naive port of the
 * design's four steps would recount an already-consumed reservationId on a
 * second consume() call and could incorrectly throw QuotaExceededError for
 * a legitimate retry once the actor is at the limit. InMemoryQuota (Phase 2)
 * avoids this by checking "does this reservationId already have a row?"
 * BEFORE counting/limit-checking, and returning success without
 * incrementing further. This adapter replicates that exact semantic inside
 * the same advisory-locked transaction, so the shared idempotency contract
 * holds for both the in-memory double and the real adapter.
 */
export class DailyFreeTierAdapter implements UsageQuotaPort {
  private readonly limit: number;

  constructor(
    private readonly prisma: PrismaClient,
    options: DailyFreeTierAdapterOptions = {},
  ) {
    this.limit = options.limit ?? 5;
  }

  async peek(actorId: string): Promise<QuotaDecision> {
    const consumed = await countConsumed(this.prisma, actorId);
    return this.decision(consumed);
  }

  async consume(actorId: string, reservationId: string): Promise<QuotaDecision> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${actorId}))`;

        const existing = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM quota_reservation WHERE id = ${reservationId}::uuid
        `;
        if (existing.length > 0) {
          // Idempotent replay: this reservationId was already consumed (or
          // refunded) previously. Don't recount against the limit — return
          // the current decision, same as InMemoryQuota's consume().
          const consumedNow = await countConsumed(tx, actorId);
          return this.decision(consumedNow);
        }

        const consumedBefore = await countConsumed(tx, actorId);
        if (consumedBefore >= this.limit) {
          throw new QuotaExceededError(actorId, this.limit, nextUtcMidnight());
        }

        await tx.$executeRaw`
          INSERT INTO quota_reservation (id, actor_id, usage_date, tier, state)
          VALUES (${reservationId}::uuid, ${actorId}, CURRENT_DATE, 'free', 'consumed')
          ON CONFLICT (id) DO NOTHING
        `;

        return this.decision(consumedBefore + 1);
      },
      { maxWait: 15_000, timeout: 15_000 },
    );
  }

  async refund(reservationId: string): Promise<void> {
    // No-op if already refunded, or if the reservationId never existed —
    // the WHERE clause only matches a row currently in state='consumed'.
    await this.prisma.$executeRaw`
      UPDATE quota_reservation SET state = 'refunded'
      WHERE id = ${reservationId}::uuid AND state = 'consumed'
    `;
  }

  private decision(consumed: number): QuotaDecision {
    const remaining = Math.max(this.limit - consumed, 0);
    return { allowed: remaining > 0, tier: "free", limit: this.limit, remaining, resetsAt: nextUtcMidnight() };
  }
}

async function countConsumed(
  client: PrismaClient | Prisma.TransactionClient,
  actorId: string,
): Promise<number> {
  const rows = await client.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM quota_reservation
    WHERE actor_id = ${actorId} AND usage_date = CURRENT_DATE AND state = 'consumed'
  `;
  return Number(rows[0]?.count ?? 0);
}

function nextUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
}
