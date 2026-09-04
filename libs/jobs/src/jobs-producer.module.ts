import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { AnalysisQueueProducer, ANALYSIS_QUEUE_NAME } from "./analysis-queue-producer";

// See design: "NestJS Wiring" - libs/jobs.
//
// Redis connection: this repo has no shared config module (no
// @nestjs/config anywhere), so this mirrors the established
// "plain env var, sane localhost default" style already used elsewhere
// (PrismaService reads DATABASE_URL the same way via Prisma's own
// env("DATABASE_URL"); apps/worker/docker/indexer/index.js reads
// CBD_SEMGREP_BIN/CBD_OSV_SCANNER_BIN the same way) rather than inventing a
// new convention. docker-compose.yml's `redis` service is the local/CI
// target these defaults point at.
//
// `BullModule.forRoot()` lives here (not in a separate shared module)
// because this batch only builds the producer side — apps/api is the only
// process importing this module today. A future consumer batch
// (JobsConsumerModule, apps/worker) will need its own Redis connection
// config too, since apps/api and apps/worker are separate processes; that's
// for that batch to wire (possibly by factoring this out then).
@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? "localhost",
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    }),
    BullModule.registerQueue({ name: ANALYSIS_QUEUE_NAME }),
  ],
  providers: [AnalysisQueueProducer],
  exports: [AnalysisQueueProducer],
})
export class JobsProducerModule {}
