import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QuotaExceededError } from "@cbd/analysis";
import { DailyFreeTierAdapter } from "./daily-free-tier-adapter";
import { startTestDatabase, type TestDatabase } from "../testing/postgres-test-db";

// Real Testcontainers Postgres — reuses the same bootstrap as
// prisma-score-repository.integration.spec.ts (task 3.4). Real
// `pg_advisory_xact_lock` is the entire point of these tests: the
// concurrency test below is what actually justifies it over a plain unique
// constraint (see class doc on DailyFreeTierAdapter).

describe("DailyFreeTierAdapter (Testcontainers Postgres)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  });

  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.prisma.$executeRaw`TRUNCATE TABLE quota_reservation CASCADE`;
  });

  it("consume succeeds and decrements remaining quota (via peek)", async () => {
    const adapter = new DailyFreeTierAdapter(db.prisma, { limit: 5 });
    const actorId = randomUUID();

    const before = await adapter.peek(actorId);
    expect(before.remaining).toBe(5);

    const decision = await adapter.consume(actorId, randomUUID());
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(4);

    const after = await adapter.peek(actorId);
    expect(after.remaining).toBe(4);
  });

  it("over-limit: the (limit+1)th consume() throws QuotaExceededError and does not insert a row", async () => {
    const adapter = new DailyFreeTierAdapter(db.prisma, { limit: 2 });
    const actorId = randomUUID();

    await adapter.consume(actorId, randomUUID());
    await adapter.consume(actorId, randomUUID());
    expect((await adapter.peek(actorId)).remaining).toBe(0);

    await expect(adapter.consume(actorId, randomUUID())).rejects.toBeInstanceOf(QuotaExceededError);

    // Confirm no row was inserted for the rejected attempt: exactly 2
    // consumed rows exist for this actor, not 3.
    const rows = await db.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM quota_reservation
      WHERE actor_id = ${actorId} AND state = 'consumed'
    `;
    expect(Number(rows[0]!.count)).toBe(2);
    expect((await adapter.peek(actorId)).remaining).toBe(0);
  });

  it("refund restores one unit of quota — the row is marked 'refunded', not deleted", async () => {
    const adapter = new DailyFreeTierAdapter(db.prisma, { limit: 2 });
    const actorId = randomUUID();
    const reservationId = randomUUID();

    await adapter.consume(actorId, reservationId);
    await adapter.consume(actorId, randomUUID());
    expect((await adapter.peek(actorId)).remaining).toBe(0);

    await adapter.refund(reservationId);

    expect((await adapter.peek(actorId)).remaining).toBe(1);

    // The row still exists — refund updates state, it does not delete.
    const rows = await db.prisma.$queryRaw<{ state: string }[]>`
      SELECT state FROM quota_reservation WHERE id = ${reservationId}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("refunded");
  });

  it("refund is idempotent: refunding the same reservation twice does not over-restore quota", async () => {
    const adapter = new DailyFreeTierAdapter(db.prisma, { limit: 2 });
    const actorId = randomUUID();
    const reservationId = randomUUID();

    await adapter.consume(actorId, reservationId);
    await adapter.consume(actorId, randomUUID());
    expect((await adapter.peek(actorId)).remaining).toBe(0);

    await adapter.refund(reservationId);
    await adapter.refund(reservationId);

    expect((await adapter.peek(actorId)).remaining).toBe(1); // not 2
  });

  it("consuming the same reservationId twice is idempotent and does not double-count", async () => {
    const adapter = new DailyFreeTierAdapter(db.prisma, { limit: 3 });
    const actorId = randomUUID();
    const reservationId = randomUUID();

    const first = await adapter.consume(actorId, reservationId);
    const second = await adapter.consume(actorId, reservationId);

    expect(first.remaining).toBe(2);
    expect(second.remaining).toBe(2); // consumed once, not twice
    expect((await adapter.peek(actorId)).remaining).toBe(2);
  });

  it("concurrency: exactly `limit` of (limit + N) simultaneous consume() calls for the same actor succeed", async () => {
    // This is THE test that justifies pg_advisory_xact_lock over a plain
    // unique constraint on (actor_id, usage_date): a unique constraint alone
    // cannot enforce a COUNT-based cap under concurrency (two transactions
    // can both read count=4 of a limit=5 before either commits its insert).
    const limit = 5;
    const extra = 7;
    const adapter = new DailyFreeTierAdapter(db.prisma, { limit });
    const actorId = randomUUID();

    const attempts = Array.from({ length: limit + extra }, () => adapter.consume(actorId, randomUUID()));
    const results = await Promise.allSettled(attempts);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(limit);
    expect(rejected).toHaveLength(extra);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(QuotaExceededError);
    }

    // Ground truth in the database, not just the resolved promises.
    const rows = await db.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM quota_reservation
      WHERE actor_id = ${actorId} AND state = 'consumed'
    `;
    expect(Number(rows[0]!.count)).toBe(limit);
    expect((await adapter.peek(actorId)).remaining).toBe(0);
  }, 30_000);
});
