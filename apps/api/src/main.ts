import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ApiModule } from "./api.module";
import { ProblemDetailsFilter } from "./errors/problem-details.filter";
import { configureHttp } from "./http-config";

// apps/api serves HTTP (unlike apps/worker, which is headless — see
// worker/src/main.ts). The RFC 9457 filter (task 5.3) is wired here, once,
// globally via `useGlobalFilters` rather than `APP_FILTER` in ApiModule:
// it has zero DI dependencies of its own (see problem-details.filter.ts),
// so there is nothing to gain from making it a Nest-managed provider, and
// wiring it at the bootstrap edge keeps ApiModule's provider list limited
// to actual business collaborators.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(ApiModule);
  app.useGlobalFilters(new ProblemDetailsFilter());
  configureHttp(app);
  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("cbd-api failed to start", err);
  process.exit(1);
});
