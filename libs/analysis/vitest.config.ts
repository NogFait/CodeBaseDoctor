import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@cbd/analysis",
    environment: "node",
    include: ["src/**/*.{spec,test}.ts", "testing/**/*.{spec,test}.ts"],
  },
});
