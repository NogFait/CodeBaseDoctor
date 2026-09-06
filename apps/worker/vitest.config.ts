import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@cbd/worker",
    environment: "node",
    include: ["src/**/*.{spec,test}.ts"],
    // stale-job-watchdog.service.integration.spec.ts spins up a real
    // Testcontainers Postgres — mirrors libs/persistence's / libs/jobs's
    // pattern.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
