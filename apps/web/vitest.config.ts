import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@cbd/web",
    environment: "jsdom",
    include: ["src/**/*.{spec,test}.ts", "src/**/*.{spec,test}.tsx"],
    setupFiles: ["src/test/setup.ts"],
  },
});
