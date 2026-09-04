import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@cbd/jobs",
    environment: "node",
    include: ["src/**/*.{spec,test}.ts"],
    // Integration specs (*.integration.spec.ts) spin up a real Testcontainers
    // Redis. Mirrors libs/persistence's / libs/repo-source's pattern.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
