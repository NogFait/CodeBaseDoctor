import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@cbd/analyzers",
    environment: "node",
    include: ["src/**/*.{spec,test}.ts"],
  },
});
