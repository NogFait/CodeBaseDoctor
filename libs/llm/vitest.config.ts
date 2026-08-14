import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@cbd/llm",
    environment: "node",
    include: ["src/**/*.{spec,test}.ts"],
  },
});
