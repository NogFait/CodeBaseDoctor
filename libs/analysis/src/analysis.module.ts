import { Module } from "@nestjs/common";
import { RepoAnalysisService } from "./application";

// See design: "NestJS Wiring" - libs/analysis: "RepoAnalysisService,
// AnalyzerRunner, ScoreAggregator. Imports NOTHING infrastructural; declares
// port tokens." AnalyzerRunner/ScoreAggregator are plain composition inside
// RepoAnalysisService (not their own providers — they're pure domain
// helpers, not swappable ports), so only the service is registered here.
//
// RESOLVED (this batch): the previously-flagged DI gap — Nest resolves a
// provider's dependencies only from its OWN module's providers plus
// whatever THAT module imports, so sibling modules imported into a common
// parent (e.g. WorkerModule importing both AnalysisDomainModule and
// PersistenceModule) do NOT automatically share providers with each other —
// is fixed WITHOUT adding any imports here. This module still imports
// nothing infrastructural, literally as documented above.
//
// The obvious-looking fix (`imports: [PersistenceModule, RepoSourceModule,
// LlmModule, AnalyzersModule]`) was tried and rejected: those four modules
// already import port tokens/error classes FROM "@cbd/analysis" (this
// package), so making @cbd/analysis import back from them creates a real
// circular PACKAGE dependency (pnpm install even warns "cyclic workspace
// dependencies" once any such edge exists — see libs/persistence's existing
// devDependency-only cycle for reference). Worse, it's a genuine runtime
// bug, not just a lint smell: since libs/analysis/src/index.ts re-exports
// this file, whichever package a given entry point (a test file,
// apps/api/src/main.ts, apps/worker/src/main.ts) happens to import FIRST
// determines the module-evaluation order of the cycle — for some import
// orders the infra module class (or this package's own tokens, seen from
// the other side) is still `undefined` mid-evaluation when the circular
// re-entry happens. Confirmed while building this fix, not merely
// theoretical, and true regardless of CommonJS vs. ESM semantics.
//
// The actual fix: PersistenceModule, RepoSourceModule, LlmModule, and
// AnalyzersModule are each marked `@Global()` (see their own files' doc
// comments). Once any one of them loads anywhere in an app's module graph —
// apps/worker/src/worker.module.ts already imports all four directly — its
// exported tokens become available to every other module in that same app,
// including this one, with zero new import edges (and zero new package
// dependencies) added to @cbd/analysis. See
// apps/worker/src/worker.module.spec.ts for the real `@nestjs/testing`
// proof that RepoAnalysisService resolves this way, with the real infra
// adapters bound (not stubs).
@Module({
  providers: [RepoAnalysisService],
  exports: [RepoAnalysisService],
})
export class AnalysisDomainModule {}
