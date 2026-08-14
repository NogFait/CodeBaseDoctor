import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@cbd/repo-source",
    environment: "node",
    include: ["src/**/*.{spec,test}.ts", "testing/**/*.{spec,test}.ts"],
    // Integration specs (*.integration.spec.ts) spin up real Docker
    // containers and a local git daemon — generously bounded, not the
    // fast-path unit specs' concern.
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
