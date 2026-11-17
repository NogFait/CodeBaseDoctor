import { Global, Module } from "@nestjs/common";
import { LLM_JUDGE_PORT, type LLMJudgePort } from "@cbd/analysis";
import { AnthropicJudgeAdapter } from "./anthropic-judge-adapter";
import { OpenAICompatibleJudgeAdapter } from "./openai-compatible-judge-adapter";
import { StubJudgeAdapter } from "./stub-judge-adapter";

/**
 * Selects the LLMJudgePort binding from the environment. Pure-ish: takes an
 * env-ish object (defaults to `process.env`) so every branch is exercisable
 * in a test without mutating global `process.env`.
 *
 * | LLM_JUDGE   | ANTHROPIC_API_KEY | NODE_ENV        | Result
 * |-------------|-------------------|-----------------|------------------------------------------
 * | "stub"      | any               | any             | StubJudgeAdapter + warn (explicit opt-in)
 * | "openai"    | n/a (LLM_API_KEY) | any             | OpenAICompatibleJudgeAdapter (needs LLM_BASE_URL + LLM_MODEL; free tiers)
 * | unset       | n/a               | any             | OpenAICompatibleJudgeAdapter when LLM_BASE_URL is set
 * | "anthropic" | any               | any             | AnthropicJudgeAdapter (key resolved lazily by the SDK)
 * | unset/other | present           | any             | AnthropicJudgeAdapter (unchanged)
 * | unset/other | absent            | != "production" | StubJudgeAdapter + a loud fallback warn
 * | unset/other | absent            | == "production" | throws — the app must NOT boot into fake-score mode in prod
 *
 * Mirrors `resolveActorSaltSecret()`'s loud-fallback style (see
 * apps/api/src/actor-id.ts): a missing secret there warns and degrades.
 * Here the non-prod fallback likewise warns-and-degrades, but in
 * production it FAIL-FASTS instead — a forgotten `ANTHROPIC_API_KEY` would
 * otherwise silently serve fabricated review scores (`modelId:"stub-judge"`)
 * that users would trust, which is worse than a crash on boot.
 */
export function selectJudge(env: NodeJS.ProcessEnv = process.env): LLMJudgePort {
  const mode = env.LLM_JUDGE?.trim().toLowerCase();

  if (mode === "stub") {
    // eslint-disable-next-line no-console
    console.warn(
      "[cbd-llm] LLM_JUDGE=stub — using StubJudgeAdapter. Review scores are " +
        "FABRICATED (modelId 'stub-judge'), NOT real LLM judgments. Unset " +
        "LLM_JUDGE and set ANTHROPIC_API_KEY for real judging.",
    );
    return new StubJudgeAdapter();
  }

  // Free-tier path: any OpenAI-compatible endpoint (Groq, Gemini, OpenRouter,
  // Ollama). Selected explicitly, or implicitly by LLM_BASE_URL being present
  // (so a production deploy on a free provider does not trip the fail-fast
  // below). Missing base URL / model is a hard misconfiguration in any env.
  if (mode === "openai" || (!mode && env.LLM_BASE_URL)) {
    if (!env.LLM_BASE_URL) {
      throw new Error("[cbd-llm] LLM_JUDGE=openai requires LLM_BASE_URL (e.g. https://api.groq.com/openai/v1).");
    }
    if (!env.LLM_MODEL) {
      throw new Error("[cbd-llm] LLM_JUDGE=openai requires LLM_MODEL (e.g. llama-3.3-70b-versatile).");
    }
    return new OpenAICompatibleJudgeAdapter({
      baseUrl: env.LLM_BASE_URL,
      modelId: env.LLM_MODEL,
      apiKey: env.LLM_API_KEY || undefined,
    });
  }

  if (mode === "anthropic" || env.ANTHROPIC_API_KEY) {
    return new AnthropicJudgeAdapter();
  }

  // LLM_JUDGE unset/unrecognised AND no ANTHROPIC_API_KEY: the old
  // silent-stub fallback. Safe in dev, catastrophic in prod.
  if (env.NODE_ENV === "production") {
    throw new Error(
      "[cbd-llm] Refusing to start: neither LLM_JUDGE nor ANTHROPIC_API_KEY " +
        "is set, so the LLM judge would silently fall back to FABRICATED " +
        "scores (modelId 'stub-judge'). Set ANTHROPIC_API_KEY (with " +
        "LLM_JUDGE unset or LLM_JUDGE=anthropic) for real judging, or set " +
        "LLM_JUDGE=stub to explicitly opt in to the offline stub.",
    );
  }

  // eslint-disable-next-line no-console
  console.warn(
    "[cbd-llm] Neither LLM_JUDGE nor ANTHROPIC_API_KEY is set — falling back " +
      "to StubJudgeAdapter. Review scores will be FABRICATED (modelId " +
      "'stub-judge'), NOT real LLM judgments. Set LLM_JUDGE=stub to silence " +
      "this warning, or set ANTHROPIC_API_KEY (optionally with " +
      "LLM_JUDGE=anthropic) for real judging.",
  );
  return new StubJudgeAdapter();
}

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
  providers: [{ provide: LLM_JUDGE_PORT, useFactory: selectJudge }],
  exports: [LLM_JUDGE_PORT],
})
export class LlmModule {}
