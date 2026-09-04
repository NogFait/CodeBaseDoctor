import { Global, Module } from "@nestjs/common";
import { CATEGORY_ANALYZERS, LLM_JUDGE_PORT, type CategoryAnalyzer, type LLMJudgePort } from "@cbd/analysis";
import { SecurityAnalyzer } from "./security-analyzer";
import { TestingAnalyzer } from "./testing-analyzer";
import { MaintainabilityAnalyzer } from "./maintainability-analyzer";
import { ArchitectureAnalyzer } from "./architecture-analyzer";
import { DocumentationAnalyzer } from "./documentation-analyzer";
import { PerformanceAnalyzer } from "./performance-analyzer";

// See design: "NestJS Wiring" - libs/analyzers. Design's own sketch shows
// `useFactory: (...6) => [...], inject: [SecurityAnalyzer, ...]` — treating
// each analyzer as its own Nest-managed provider. That doesn't work as
// written for ArchitectureAnalyzer/DocumentationAnalyzer: their
// constructors take `LLMJudgePort`, an INTERFACE, and Nest's
// reflection-based constructor injection can't resolve an interface type
// (erased at runtime — same "Object" token pitfall as RepoSourceModule,
// see that file's comment). Registering ArchitectureAnalyzer/
// DocumentationAnalyzer as their own `useClass` providers would hit the
// exact same problem. Instead: ONE factory, injecting only the
// Nest-resolvable token (LLM_JUDGE_PORT), constructing all 6 analyzers by
// hand. Same array shape the design asks for; different plumbing to get
// there.
//
// `@Global()`: see analysis.module.ts's comment for the DI-gap this
// resolves and why it's `@Global()` rather than a direct import from
// AnalysisDomainModule.
@Global()
@Module({
  providers: [
    {
      provide: CATEGORY_ANALYZERS,
      useFactory: (judge: LLMJudgePort): readonly CategoryAnalyzer[] => [
        new SecurityAnalyzer(),
        new TestingAnalyzer(),
        new MaintainabilityAnalyzer(),
        new ArchitectureAnalyzer(judge),
        new DocumentationAnalyzer(judge),
        new PerformanceAnalyzer(),
      ],
      inject: [LLM_JUDGE_PORT],
    },
  ],
  exports: [CATEGORY_ANALYZERS],
})
export class AnalyzersModule {}
