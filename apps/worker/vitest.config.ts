import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@cbd/worker",
    environment: "node",
    include: ["src/**/*.{spec,test}.ts"],
  },
});
