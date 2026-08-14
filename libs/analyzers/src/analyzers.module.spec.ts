import { Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { CATEGORY_ANALYZERS, LLM_JUDGE_PORT, type CategoryAnalyzer, type CategoryId } from "@cbd/analysis";
import { ScriptedJudge } from "@cbd/llm/testing/scripted-judge";
import { AnalyzersModule } from "./analyzers.module";

// Nest module encapsulation: a provider declared directly on the root
// testing module is NOT automatically visible inside AnalyzersModule's own
// factory (each module only sees its own providers + what its imports
// export). A tiny @Global() stand-in for the real LlmModule (Phase 3 batch
// B, not built yet) makes LLM_JUDGE_PORT resolvable everywhere in this
// test's module graph, the same way the real WorkerModule will make it
// resolvable by actually importing LlmModule.
@Global()
@Module({
  providers: [{ provide: LLM_JUDGE_PORT, useValue: new ScriptedJudge(new Map()) }],
  exports: [LLM_JUDGE_PORT],
})
class FakeLlmModule {}

describe("AnalyzersModule", () => {
  it("resolves CATEGORY_ANALYZERS to exactly 6 analyzers, one per CategoryId", async () => {
    // ArchitectureAnalyzer/DocumentationAnalyzer need LLM_JUDGE_PORT, which
    // in production comes from LlmModule (still a Phase 1 placeholder —
    // the real LLM adapter is Phase 3 batch B, out of scope here).
    // FakeLlmModule stands in for it so this test proves AnalyzersModule's
    // OWN wiring is correct; WorkerModule importing the real LlmModule
    // alongside AnalyzersModule is what makes this resolve in production.
    const moduleRef = await Test.createTestingModule({
      imports: [FakeLlmModule, AnalyzersModule],
    }).compile();

    const analyzers = moduleRef.get<readonly CategoryAnalyzer[]>(CATEGORY_ANALYZERS);

    expect(analyzers).toHaveLength(6);

    const categories = analyzers.map((a) => a.category).sort();
    const expected: CategoryId[] = [
      "architecture",
      "documentation",
      "maintainability",
      "performance",
      "security",
      "testing",
    ].sort() as CategoryId[];
    expect(categories).toEqual(expected);

    // Every analyzer instance is distinct and implements the real contract
    // (readable `confidence`, not undefined) — not a placeholder array.
    for (const analyzer of analyzers) {
      expect(analyzer.confidence).toMatch(/^(measured|estimated|judged)$/);
      expect(typeof analyzer.analyzerVersion).toBe("string");
    }

    const performance = analyzers.find((a) => a.category === "performance");
    expect(performance).toBeDefined();
  });
});
