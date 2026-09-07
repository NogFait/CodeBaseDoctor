import type { Redis } from "ioredis";
import type { OnModuleDestroy } from "@nestjs/common";
import { HeadCallRateLimitExceededError, type HeadCallRateLimiterPort } from "@cbd/analysis";

export interface RedisHeadCallRateLimiterAdapterOptions {
  /** Max `head()` attempts allowed per actor per window. */
  limit?: number;
  /** Fixed window size, in ms. */
  windowMs?: number;
}

/** MVP default: 20 `head()` attempts per actor per rolling hour. Named
 * constant, not a magic number, per task requirement — tune here. */
export const DEFAULT_HEAD_CALL_RATE_LIMIT = 20;
export const DEFAULT_HEAD_CALL_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/**
 * RedisHeadCallRateLimiterAdapter — `HeadCallRateLimiterPort` implementation.
 * Fixed-window counter: `INCR` a key scoped to `{actorId, windowBucket}`,
 * `PEXPIRE` it on the FIRST increment of that window so stale keys
 * self-clean, reject once the count exceeds the limit.
 *
 * Chosen over a Postgres-backed counter (the `DailyFreeTierAdapter`
 * pattern) because Redis is already a first-class dependency of this
 * project — `libs/jobs`'s `JobsProducerModule` needs it for BullMQ's queue
 * connection — and a fixed-window `INCR`/`EXPIRE` pair is the idiomatic,
 * low-overhead pattern for this kind of high-frequency, disposable,
 * non-transactional counter. Unlike `DailyFreeTierAdapter`'s quota ledger,
 * this needs no refund/idempotency semantics, no durability guarantee
 * across a Redis restart, and no cross-row transactional consistency —
 * losing an in-flight window's count on a Redis restart just means an
 * actor gets a few extra `head()` attempts, not a correctness bug.
 */
export class RedisHeadCallRateLimiterAdapter implements HeadCallRateLimiterPort, OnModuleDestroy {
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(
    private readonly redis: Redis,
    options: RedisHeadCallRateLimiterAdapterOptions = {},
  ) {
    this.limit = options.limit ?? DEFAULT_HEAD_CALL_RATE_LIMIT;
    this.windowMs = options.windowMs ?? DEFAULT_HEAD_CALL_RATE_LIMIT_WINDOW_MS;
  }

  /**
   * Nest calls this automatically when the owning module/app is destroyed
   * (`app.close()`/`moduleRef.close()` — no `enableShutdownHooks()`
   * needed for this). Without it, this adapter's own DEDICATED ioredis
   * client (see `PersistenceModule`'s `useFactory` — deliberately not
   * shared with BullMQ's own connection) keeps retrying to reconnect
   * indefinitely after the app shuts down. Confirmed via a genuine RED:
   * running the full E2E suite before this hook existed leaked
   * `[ioredis] Unhandled error event: ECONNREFUSED`/`ECONNRESET` noise from
   * a PREVIOUS test's already-torn-down Testcontainers Redis into LATER,
   * unrelated E2E specs sharing the same Vitest worker process.
   */
  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  async checkAndRecord(actorId: string): Promise<void> {
    const windowBucket = Math.floor(Date.now() / this.windowMs);
    const key = `head-rate:${actorId}:${windowBucket}`;

    const count = await this.redis.incr(key);
    if (count === 1) {
      // First increment seen for this window bucket — set the key to
      // self-expire around the window boundary so it never accumulates
      // forever. A crash between INCR and PEXPIRE would leave a
      // non-expiring key for this one bucket; acceptable for this
      // disposable, best-effort counter (see class doc comment).
      await this.redis.pexpire(key, this.windowMs);
    }

    if (count > this.limit) {
      const resetsAt = new Date((windowBucket + 1) * this.windowMs);
      throw new HeadCallRateLimitExceededError(actorId, this.limit, resetsAt);
    }
  }
}
