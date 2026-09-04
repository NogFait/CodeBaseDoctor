import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Queue } from "bullmq";
import { AnalysisQueueProducer } from "./analysis-queue-producer";

// Real Testcontainers Redis, real BullMQ Queue — no mocking of BullMQ/Redis
// itself. Mirrors this repo's established integration-test pattern
// (Testcontainers Postgres for PrismaScoreRepository / DailyFreeTierAdapter).
// Direct construction (`new AnalysisQueueProducer(queue)`), not
// `Test.createTestingModule`, also mirrors how those specs directly
// construct their adapter under test against a real client rather than
// going through Nest DI.

describe("AnalysisQueueProducer (Testcontainers Redis)", () => {
  let container: StartedRedisContainer;
  let queue: Queue;

  beforeAll(async () => {
    container = await new RedisContainer("redis:7-alpine").start();
    queue = new Queue("analysis", {
      connection: { host: container.getHost(), port: container.getMappedPort(6379) },
    });
  }, 60_000);

  afterAll(async () => {
    await queue.close();
    await container.stop();
  });

  afterEach(async () => {
    await queue.obliterate({ force: true });
  });

  it("places a job on the real 'analysis' queue with the right payload", async () => {
    const producer = new AnalysisQueueProducer(queue);

    const bullJobId = await producer.enqueue("job-1", {
      repoUrl: "https://github.com/acme/widget",
      actorId: "user-1",
      reservationId: "11111111-1111-1111-1111-111111111111",
    });

    const job = await queue.getJob(bullJobId);
    expect(job).not.toBeNull();
    expect(job?.name).toBe("analyze");
    expect(job?.data).toEqual({
      analysisJobId: "job-1",
      repoUrl: "https://github.com/acme/widget",
      actorId: "user-1",
      reservationId: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("enqueues a second, independent job with its own id and payload (triangulation)", async () => {
    const producer = new AnalysisQueueProducer(queue);

    const idA = await producer.enqueue("job-a", {
      repoUrl: "https://github.com/acme/a",
      actorId: "user-a",
      reservationId: "22222222-2222-2222-2222-222222222222",
    });
    const idB = await producer.enqueue("job-b", {
      repoUrl: "https://github.com/acme/b",
      actorId: "user-b",
      reservationId: "33333333-3333-3333-3333-333333333333",
    });

    expect(idA).not.toBe(idB);
    const jobB = await queue.getJob(idB);
    expect(jobB?.data.analysisJobId).toBe("job-b");
    expect(jobB?.data.repoUrl).toBe("https://github.com/acme/b");
  });

  it("enqueues with attempts: 1 — no automatic BullMQ retry", async () => {
    const producer = new AnalysisQueueProducer(queue);

    const id = await producer.enqueue("job-retry-check", {
      repoUrl: "https://github.com/acme/c",
      actorId: "user-c",
      reservationId: "44444444-4444-4444-4444-444444444444",
    });

    const job = await queue.getJob(id);
    expect(job?.opts.attempts).toBe(1);
  });
});
