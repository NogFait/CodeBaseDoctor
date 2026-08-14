import { Module } from "@nestjs/common";

// Placeholder for Phase 1. Real provider lands in Phase 3:
//   { provide: LLM_JUDGE_PORT, useClass: AnthropicJudgeAdapter }
// See design: "NestJS Wiring" - libs/llm.
@Module({})
export class LlmModule {}
