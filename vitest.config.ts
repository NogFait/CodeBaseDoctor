import { defineConfig } from "vitest/config";

// Root Vitest config. Each workspace package (apps/*, libs/*) that has tests
// owns its own vitest.config.ts (see e.g. libs/analysis/vitest.config.ts);
// "projects" wires them all into a single `pnpm test` run from the repo root.
export default defineConfig({
  test: {
    projects: ["apps/*", "libs/*"],
  },
});
