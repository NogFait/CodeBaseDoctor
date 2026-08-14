import { execFileSync } from "node:child_process";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "@prisma/client";

// Shared Testcontainers Postgres bootstrap for PrismaScoreRepository (3.4)
// and DailyFreeTierAdapter (3.5) integration specs. Applies Phase 1's real
// migration.sql (via `prisma migrate deploy`, the same command
// `libs/persistence/package.json`'s `prisma:migrate` script runs in
// production) against a real, ephemeral Postgres 16 container — not a
// hand-rolled schema recreation — so these tests exercise the exact same DDL
// (including the hand-written partial unique indexes) that production runs.

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const PRISMA_BIN = path.resolve(PACKAGE_ROOT, "node_modules/.bin/prisma");

export interface TestDatabase {
  readonly prisma: PrismaClient;
  readonly connectionUri: string;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("postgres:16-alpine").start();
  const connectionUri = container.getConnectionUri();

  execFileSync(PRISMA_BIN, ["migrate", "deploy", "--schema", "prisma/schema.prisma"], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, DATABASE_URL: connectionUri },
    stdio: "pipe",
  });

  const prisma = new PrismaClient({ datasourceUrl: connectionUri });
  await prisma.$connect();

  return {
    prisma,
    connectionUri,
    async stop() {
      await prisma.$disconnect();
      await container.stop();
    },
  };
}
