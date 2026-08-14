import { QuotaExceededError } from "@cbd/analysis";
import { describe, expect, it } from "vitest";
import { InMemoryQuota } from "./in-memory-quota";

describe("InMemoryQuota", () => {
  it("consume decrements remaining by one per call", async () => {
    const quota = new InMemoryQuota({ limit: 3 });

    const first = await quota.consume("actor-1", "res-1");
    expect(first.remaining).toBe(2);

    const second = await quota.consume("actor-1", "res-2");
    expect(second.remaining).toBe(1);
  });

  it("throws QuotaExceededError over the limit and does not decrement further", async () => {
    const quota = new InMemoryQuota({ limit: 1 });
    await quota.consume("actor-1", "res-1");

    await expect(quota.consume("actor-1", "res-2")).rejects.toBeInstanceOf(QuotaExceededError);

    // remaining stays at 0 - the rejected attempt must not go negative
    const decision = await quota.peek("actor-1");
    expect(decision.remaining).toBe(0);
    expect(quota.consumeCalls).toHaveLength(2); // both attempts recorded, even the rejected one
  });

  it("refund restores one unit of quota", async () => {
    const quota = new InMemoryQuota({ limit: 2 });
    await quota.consume("actor-1", "res-1");
    await quota.consume("actor-1", "res-2");
    expect((await quota.peek("actor-1")).remaining).toBe(0);

    await quota.refund("res-1");

    expect((await quota.peek("actor-1")).remaining).toBe(1);
    expect(quota.refundCalls).toEqual(["res-1"]);
  });

  it("double-refund does not over-restore quota (idempotent)", async () => {
    const quota = new InMemoryQuota({ limit: 2 });
    await quota.consume("actor-1", "res-1");
    await quota.consume("actor-1", "res-2");

    await quota.refund("res-1");
    await quota.refund("res-1");

    expect((await quota.peek("actor-1")).remaining).toBe(1); // not 2
    expect(quota.refundCalls).toEqual(["res-1", "res-1"]); // both calls recorded
  });

  it("consuming the same reservationId twice does not double-count (consume idempotency)", async () => {
    const quota = new InMemoryQuota({ limit: 3 });

    await quota.consume("actor-1", "res-1");
    await quota.consume("actor-1", "res-1");

    expect((await quota.peek("actor-1")).remaining).toBe(2); // consumed once, not twice
  });
});
