import { Module } from "@nestjs/common";

// Placeholder for Phase 1. Real wiring lands in Phase 3:
//   { provide: CATEGORY_ANALYZERS, useFactory: (...6 analyzers) => [...],
//     inject: [SecurityAnalyzer, TestingAnalyzer, MaintainabilityAnalyzer,
//              ArchitectureAnalyzer, DocumentationAnalyzer, PerformanceAnalyzer] }
// See design: "NestJS Wiring" - libs/analyzers.
@Module({})
export class AnalyzersModule {}
