import { Global, Module } from "@nestjs/common";
import { LLM_JUDGE_PORT } from "@cbd/analysis";
import { AnthropicJudgeAdapter } from "./anthropic-judge-adapter";

// See design: "NestJS Wiring" - libs/llm.
// useFactory (not useClass): AnthropicJudgeAdapter's constructor takes a
// plain options interface (client?, modelId?), not Nest-resolvable tokens —
// same reflection-metadata pitfall documented for RepoSourceModule and
// AnalyzersModule (an interface/plain-object constructor param is erased at
// runtime, so Nest's reflection-based injection can't resolve it).
//
// `@Global()`: see analysis.module.ts and repo-source.module.ts's comments
// for the DI-gap this resolves and why it's `@Global()` rather than a
// direct import from AnalysisDomainModule.
@Global()
@Module({
  providers: [{ provide: LLM_JUDGE_PORT, useFactory: () => new AnthropicJudgeAdapter() }],
  exports: [LLM_JUDGE_PORT],
})
export class LlmModule {}
