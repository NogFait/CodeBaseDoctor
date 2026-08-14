import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@cbd/web",
    environment: "node",
    include: ["src/**/*.{spec,test}.ts", "src/**/*.{spec,test}.tsx"],
  },
});
