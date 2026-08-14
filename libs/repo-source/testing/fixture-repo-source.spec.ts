import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FixtureRepoSource } from "./fixture-repo-source";

// Fixture paths under libs/analyzers/__fixtures__. Ground-truth LOC per file
// below was independently verified with `wc -l` against the committed
// fixture files (not derived from this double's own implementation) —
// see apply-progress notes for the exact command output.
const FIXTURES_ROOT = path.resolve(__dirname, "../../analyzers/__fixtures__");

describe("FixtureRepoSource", () => {
  describe("well-tested-ts fixture", () => {
    it("materialize() returns a RepoContext matching the real fixture tree", async () => {
      const source = new FixtureRepoSource(path.join(FIXTURES_ROOT, "well-tested-ts"));
      const ref = await source.resolve("https://github.com/fixture/well-tested-ts");
      const workspace = await source.materialize(ref, "c".repeat(40), {
        maxVolumeBytes: 1_000_000,
        maxFiles: 100,
        cloneTimeoutMs: 1000,
      });
      const ctx = workspace.context;

      expect(ctx.files.map((f) => f.path).sort()).toEqual([
        "package.json",
        "src/sum.test.ts",
        "src/sum.ts",
        "tsconfig.json",
      ]);

      // package.json=5, tsconfig.json=6 (non-language, excluded from totalLoc);
      // sum.ts=3, sum.test.ts=8 (TypeScript) -> totalLoc = 3 + 8 = 11
      expect(ctx.totalLoc).toBe(11);
      expect(ctx.dominantLanguage).toBe("TypeScript");
      expect(ctx.languageMix).toEqual([{ language: "TypeScript", loc: 11, share: 1 }]);

      const sumFile = ctx.files.find((f) => f.path === "src/sum.ts");
      expect(sumFile).toMatchObject({ loc: 3, language: "TypeScript" });

      await workspace.dispose();
    });
  });

  describe("no-tests-py fixture", () => {
    it("materialize() returns a RepoContext with zero test files and Python dominant", async () => {
      const source = new FixtureRepoSource(path.join(FIXTURES_ROOT, "no-tests-py"));
      const ref = await source.resolve("https://github.com/fixture/no-tests-py");
      const workspace = await source.materialize(ref, "d".repeat(40), {
        maxVolumeBytes: 1_000_000,
        maxFiles: 100,
        cloneTimeoutMs: 1000,
      });
      const ctx = workspace.context;

      const paths = ctx.files.map((f) => f.path).sort();
      expect(paths).toEqual(["README.md", "main.py", "requirements.txt"]);
      expect(paths.some((p) => /test/i.test(p))).toBe(false);

      // main.py=10 (Python, only recognized-language file) -> totalLoc = 10
      expect(ctx.totalLoc).toBe(10);
      expect(ctx.dominantLanguage).toBe("Python");
      expect(ctx.languageMix).toEqual([{ language: "Python", loc: 10, share: 1 }]);
    });
  });

  describe("monorepo fixture", () => {
    it("materialize() exercises multi-language detection across two sub-packages", async () => {
      const source = new FixtureRepoSource(path.join(FIXTURES_ROOT, "monorepo"));
      const ref = await source.resolve("https://github.com/fixture/monorepo");
      const workspace = await source.materialize(ref, "e".repeat(40), {
        maxVolumeBytes: 1_000_000,
        maxFiles: 100,
        cloneTimeoutMs: 1000,
      });
      const ctx = workspace.context;

      expect(ctx.files.map((f) => f.path).sort()).toEqual([
        "package.json",
        "packages/js-pkg/index.js",
        "packages/js-pkg/package.json",
        "packages/py-pkg/main.py",
        "packages/py-pkg/requirements.txt",
      ]);

      // index.js=5 (JavaScript), main.py=2 (Python) -> totalLoc = 5 + 2 = 7
      expect(ctx.totalLoc).toBe(7);
      expect(ctx.languageMix).toHaveLength(2);
      expect(ctx.languageMix).toEqual([
        { language: "JavaScript", loc: 5, share: 5 / 7 },
        { language: "Python", loc: 2, share: 2 / 7 },
      ]);
      // JS share 5/7 ~= 0.714 clears the 0.40 dominance threshold
      expect(ctx.dominantLanguage).toBe("JavaScript");
    });
  });

  describe("readFile", () => {
    it("returns the real file content read from disk", async () => {
      const source = new FixtureRepoSource(path.join(FIXTURES_ROOT, "well-tested-ts"));
      const ref = await source.resolve("https://github.com/fixture/well-tested-ts");
      const workspace = await source.materialize(ref, "c".repeat(40), {
        maxVolumeBytes: 1_000_000,
        maxFiles: 100,
        cloneTimeoutMs: 1000,
      });

      const content = await workspace.context.readFile("src/sum.ts");

      expect(content).toContain("export function sum(a: number, b: number): number");
    });

    it("rejects an unknown path instead of silently returning empty content", async () => {
      const source = new FixtureRepoSource(path.join(FIXTURES_ROOT, "well-tested-ts"));
      const ref = await source.resolve("https://github.com/fixture/well-tested-ts");
      const workspace = await source.materialize(ref, "c".repeat(40), {
        maxVolumeBytes: 1_000_000,
        maxFiles: 100,
        cloneTimeoutMs: 1000,
      });

      await expect(workspace.context.readFile("src/does-not-exist.ts")).rejects.toThrow(/unknown file/);
    });
  });
});
