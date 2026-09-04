import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@cbd/repo-source",
    environment: "node",
    include: ["src/**/*.{spec,test}.ts", "testing/**/*.{spec,test}.ts"],
    // Integration specs (*.integration.spec.ts) spin up real Docker
    // containers and a local git daemon. 60s was enough while cbd-scanner
    // only did a fast file walk; since task 3.2.8 wired real Semgrep +
    // OSV-Scanner into the same container, every materialize() call now
    // also pays for a real scan — verified directly, a cold cbd-scanner
    // run against a trivial fixture alone took ~56s (osv-scanner
    // copying + loading the baked ~240MB offline vulnerability DB off the
    // image dominates that). Bumped with real margin above the measured
    // worst case, matching @cbd/analyzers' integration-spec timeout.
    testTimeout: 180_000,
    hookTimeout: 30_000,
  },
});
