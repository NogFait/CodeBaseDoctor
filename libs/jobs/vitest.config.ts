import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@cbd/jobs",
    environment: "node",
    include: ["src/**/*.{spec,test}.ts"],
  },
});
