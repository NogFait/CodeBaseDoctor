import { describe, expect, it } from "vitest";

// First test in the repo - proves the Vitest runner is wired end to end
// (root config -> per-package project -> `pnpm test`) before any TDD-gated
// task in Phase 2+ depends on it. See tasks.md 1.2.
describe("vitest runner sanity", () => {
  it("runs a trivial assertion", () => {
    expect(1 + 1).toBe(2);
  });
});
