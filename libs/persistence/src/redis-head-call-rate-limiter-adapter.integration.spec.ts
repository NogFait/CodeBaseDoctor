import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Redis } from "ioredis";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { HeadCallRateLimitExceededError } from "@cbd/analysis";
import { RedisHeadCallRateLimiterAdapter } from "./redis-head-call-rate-limiter-adapter";

// Real Testcontainers Redis — same style as
// libs/jobs/src/analysis-processor.integration.spec.ts and
// libs/persistence/src/daily-free-tier-adapter.integration.spec.ts (real
// Postgres for that one). The fixed-window INCR/EXPIRE mechanics this
// adapter relies on are exactly what's worth testing against a real Redis,
// not a mock.

describe("RedisHeadCallRateLimiterAdapter (Testcontainers Redis)", () => {
  let redisContainer: StartedRedisContainer;
  let redis: Redis;

  beforeAll(async () => {
    redisContainer = await new RedisContainer("redis:7-alpine").start();
    redis = new Redis({ host: redisContainer.getHost(), port: redisContainer.getMappedPort(6379) });
  }, 60_000);

  afterAll(async () => {
    redis.disconnect();
    await redisContainer.stop();
  });

  afterEach(async () => {
    await redis.flushall();
  });

  it("allows attempts under the limit and does not throw", async () => {
    const adapter = new RedisHeadCallRateLimiterAdapter(redis, { limit: 3, windowMs: 60_000 });
    const actorId = randomUUID();

    await expect(adapter.checkAndRecord(actorId)).resolves.toBeUndefined();
    await expect(adapter.checkAndRecord(actorId)).resolves.toBeUndefined();
    await expect(adapter.checkAndRecord(actorId)).resolves.toBeUndefined();
  });

  it("throws HeadCallRateLimitExceededError once the limit is exceeded for that actor", async () => {
    const adapter = new RedisHeadCallRateLimiterAdapter(redis, { limit: 2, windowMs: 60_000 });
    const actorId = randomUUID();

    await adapter.checkAndRecord(actorId);
    await adapter.checkAndRecord(actorId);

    await expect(adapter.checkAndRecord(actorId)).rejects.toBeInstanceOf(HeadCallRateLimitExceededError);
  });

  it("carries actorId and limit on the thrown error", async () => {
    const adapter = new RedisHeadCallRateLimiterAdapter(redis, { limit: 1, windowMs: 60_000 });
    const actorId = randomUUID();

    await adapter.checkAndRecord(actorId);
    await expect(adapter.checkAndRecord(actorId)).rejects.toMatchObject({ actorId, limit: 1 });
  });

  it("tracks each actor independently — one actor being over limit does not affect another", async () => {
    const adapter = new RedisHeadCallRateLimiterAdapter(redis, { limit: 1, windowMs: 60_000 });
    const actorA = randomUUID();
    const actorB = randomUUID();

    await adapter.checkAndRecord(actorA);
    await expect(adapter.checkAndRecord(actorA)).rejects.toBeInstanceOf(HeadCallRateLimitExceededError);

    // actorB's own first attempt in the same window must still be allowed.
    await expect(adapter.checkAndRecord(actorB)).resolves.toBeUndefined();
  });

  it("onModuleDestroy() disconnects its own dedicated ioredis client — Nest calls this on app.close()", () => {
    // Without this, the adapter's own dedicated ioredis client (see
    // PersistenceModule's useFactory) keeps retrying to reconnect
    // indefinitely after the owning Nest app shuts down — confirmed via a
    // genuine RED: real E2E test runs (apps/api/src/e2e/*.e2e.spec.ts)
    // leaked "[ioredis] Unhandled error event: ECONNREFUSED"/"ECONNRESET"
    // noise from a PREVIOUS test's already-stopped Testcontainers Redis
    // into LATER, unrelated e2e specs in the same Vitest worker process,
    // before this hook existed.
    const adapter = new RedisHeadCallRateLimiterAdapter(redis, { limit: 1, windowMs: 60_000 });
    // mockImplementation(() => {}) — this test must NOT actually tear down
    // the shared `redis` connection every other test in this file reuses;
    // it only needs to prove the hook calls disconnect().
    const disconnectSpy = vi.spyOn(redis, "disconnect").mockImplementation(() => {});

    adapter.onModuleDestroy();

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    disconnectSpy.mockRestore();
  });

  it("a new window resets the count — an actor blocked in one window is allowed again once the window rolls over", async () => {
    // A short window (50ms) lets this test actually observe the rollover
    // without a long sleep.
    const adapter = new RedisHeadCallRateLimiterAdapter(redis, { limit: 1, windowMs: 50 });
    const actorId = randomUUID();

    await adapter.checkAndRecord(actorId);
    await expect(adapter.checkAndRecord(actorId)).rejects.toBeInstanceOf(HeadCallRateLimitExceededError);

    await new Promise((resolve) => setTimeout(resolve, 120));

    await expect(adapter.checkAndRecord(actorId)).resolves.toBeUndefined();
  });
});
