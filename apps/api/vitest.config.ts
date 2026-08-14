import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@cbd/api",
    environment: "node",
    include: ["src/**/*.{spec,test}.ts"],
  },
});
