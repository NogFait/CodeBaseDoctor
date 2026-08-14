import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module";

// Headless process: no HTTP server. The worker only consumes BullMQ jobs
// (wired in Phase 6) and talks to Postgres/Docker/the LLM provider through
// the ports provided by WorkerModule. See design: "NestJS Wiring".
async function bootstrap(): Promise<void> {
  await NestFactory.createApplicationContext(WorkerModule);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("cbd-worker failed to start", err);
  process.exit(1);
});
