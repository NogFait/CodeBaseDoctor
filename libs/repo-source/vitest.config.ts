import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@cbd/repo-source",
    environment: "node",
    include: ["src/**/*.{spec,test}.ts", "testing/**/*.{spec,test}.ts"],
  },
});
