import { afterEach, describe, expect, it } from "vitest";
import type { CategoryId, JudgeRequest } from "@cbd/analysis";
import { StubJudgeAdapter } from "./stub-judge-adapter";

/**
 * StubJudgeAdapter is the FREE, offline LLMJudgePort used by the local dev
 * harness (see DEV-HARNESS.md) — zero API cost, no network, no
 * ANTHROPIC_API_KEY. It must be deterministic (same request -> same verdict)
 * so a re-scan of the same repo reproduces byte-for-byte, and
 * pseudo-varied per category so a rendered report doesn't show six
 * identical cards.
 */

const CATEGORIES: CategoryId[] = [
  "architecture",
  "security",
  "testing",
  "maintainability",
  "performance",
  "documentation",
];

function makeRequest(overrides: Partial<JudgeRequest> = {}): JudgeRequest {
  return {
    category: "architecture",
    rubricId: "architecture-v1",
    rubricVersion: "1.0.0",
    systemPrompt: "You are a strict architecture reviewer.",
    userPrompt: "Repo tree:\n- src/index.ts",
    maxOutputTokens: 512,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.STUB_JUDGE_FAIL_CATEGORIES;
});

describe("StubJudgeAdapter", () => {
  it("is deterministic: the same request yields an identical verdict", async () => {
    const adapter = new StubJudgeAdapter();
    const req = makeRequest({ category: "security", rubricId: "security-v3" });

    const a = await adapter.judge(req, new AbortController().signal);
    const b = await adapter.judge(req, new AbortController().signal);

    expect(a).toEqual(b);
  });

  it("returns a score inside [0,100] for every category", async () => {
    const adapter = new StubJudgeAdapter();

    for (const category of CATEGORIES) {
      const verdict = await adapter.judge(makeRequest({ category }), new AbortController().signal);
      expect(verdict.score).toBeGreaterThanOrEqual(0);
      expect(verdict.score).toBeLessThanOrEqual(100);
      expect(Number.isInteger(verdict.score)).toBe(true);
    }
  });

  it("produces a non-empty rationale that names the category and marks itself a stub", async () => {
    const adapter = new StubJudgeAdapter();

    const verdict = await adapter.judge(makeRequest({ category: "documentation" }), new AbortController().signal);

    expect(verdict.rationale.trim().length).toBeGreaterThan(0);
    expect(verdict.rationale).toContain("documentation");
    expect(verdict.rationale.toLowerCase()).toContain("stub");
  });

  it("gives distinct scores across the six CategoryIds for one rubric", async () => {
    const adapter = new StubJudgeAdapter();

    const scores = await Promise.all(
      CATEGORIES.map((category) =>
        adapter
          .judge(makeRequest({ category, rubricId: "shared-rubric-v1" }), new AbortController().signal)
          .then((v) => v.score),
      ),
    );

    expect(new Set(scores).size).toBe(CATEGORIES.length);
  });

  it("reports its own model id and zero token usage", async () => {
    const adapter = new StubJudgeAdapter();

    const verdict = await adapter.judge(makeRequest(), new AbortController().signal);

    expect(verdict.modelId).toBe("stub-judge");
    expect(verdict.promptTokens).toBe(0);
    expect(verdict.completionTokens).toBe(0);
  });

  it("rejects when handed an already-aborted signal", async () => {
    const adapter = new StubJudgeAdapter();
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.judge(makeRequest(), controller.signal)).rejects.toThrow();
  });

  it("throws for a category listed in the constructor's failCategories, but not for the others", async () => {
    const adapter = new StubJudgeAdapter({ failCategories: ["security"] });

    await expect(
      adapter.judge(makeRequest({ category: "security" }), new AbortController().signal),
    ).rejects.toThrow(/stub/i);

    const ok = await adapter.judge(makeRequest({ category: "architecture" }), new AbortController().signal);
    expect(ok.score).toBeGreaterThanOrEqual(0);
  });

  it("reads STUB_JUDGE_FAIL_CATEGORIES from the environment when no option is passed", async () => {
    process.env.STUB_JUDGE_FAIL_CATEGORIES = "testing, performance";
    const adapter = new StubJudgeAdapter();

    await expect(
      adapter.judge(makeRequest({ category: "testing" }), new AbortController().signal),
    ).rejects.toThrow();
    await expect(
      adapter.judge(makeRequest({ category: "performance" }), new AbortController().signal),
    ).rejects.toThrow();

    const ok = await adapter.judge(makeRequest({ category: "documentation" }), new AbortController().signal);
    expect(ok.modelId).toBe("stub-judge");
  });
});
