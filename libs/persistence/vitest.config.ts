import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@cbd/persistence",
    environment: "node",
    include: ["src/**/*.{spec,test}.ts", "testing/**/*.{spec,test}.ts"],
    // Integration specs (*.integration.spec.ts) spin up a real Testcontainers
    // Postgres, apply the real migration, and (for the quota concurrency
    // test) run many real concurrent transactions — generously bounded, not
    // the fast-path unit specs' concern. Mirrors libs/repo-source's pattern.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
