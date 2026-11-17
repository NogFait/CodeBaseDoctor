import { describe, expect, it, vi } from "vitest";
import type { JudgeRequest } from "@cbd/analysis";
import { LLMResponseParseError } from "./anthropic-judge-adapter";
import { LLMProviderError, OpenAICompatibleJudgeAdapter } from "./openai-compatible-judge-adapter";

/**
 * No real network: `fetch` is injected. Targets any OpenAI-compatible
 * `/chat/completions` endpoint (Groq, Gemini's compat layer, OpenRouter,
 * Ollama), all of which have a free tier or run locally.
 */

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

function completion(content: unknown, extra: Record<string, unknown> = {}) {
  return {
    model: "llama-3.3-70b-versatile",
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
    ...extra,
  };
}

function okFetch(body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  );
}

function build(fetchImpl: ReturnType<typeof okFetch>, opts: { apiKey?: string; baseUrl?: string } = {}) {
  return new OpenAICompatibleJudgeAdapter({
    baseUrl: opts.baseUrl ?? "https://api.groq.com/openai/v1",
    apiKey: "apiKey" in opts ? opts.apiKey : "gsk_test",
    modelId: "llama-3.3-70b-versatile",
    fetch: fetchImpl as unknown as typeof fetch,
  });
}

describe("OpenAICompatibleJudgeAdapter", () => {
  it("maps a well-formed JSON completion to a JudgeVerdict", async () => {
    const fetchImpl = okFetch(completion('{"score": 72, "rationale": "Clear module boundaries."}'));

    const verdict = await build(fetchImpl).judge(makeRequest(), new AbortController().signal);

    expect(verdict).toEqual({
      score: 72,
      rationale: "Clear module boundaries.",
      modelId: "llama-3.3-70b-versatile",
      promptTokens: 100,
      completionTokens: 30,
    });
  });

  it("POSTs to <baseUrl>/chat/completions with bearer auth, temperature 0, JSON mode and the abort signal", async () => {
    const fetchImpl = okFetch(completion('{"score": 50, "rationale": "ok"}'));
    const signal = new AbortController().signal;

    await build(fetchImpl, { baseUrl: "https://api.groq.com/openai/v1/" }).judge(makeRequest(), signal);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer gsk_test");
    expect(init?.signal).toBe(signal);
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("llama-3.3-70b-versatile");
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(512);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("puts the rubric tag and a JSON-only instruction in the system prompt, and the user prompt as the user turn", async () => {
    const fetchImpl = okFetch(completion('{"score": 50, "rationale": "ok"}'));

    await build(fetchImpl).judge(makeRequest(), new AbortController().signal);

    const body = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("You are a strict architecture reviewer.");
    expect(body.messages[0].content).toContain("[rubric: architecture-v1 v1.0.0]");
    expect(body.messages[0].content).toMatch(/"score".*"rationale"/s);
    expect(body.messages[1]).toEqual({ role: "user", content: "Repo tree:\n- src/index.ts" });
  });

  it("omits the Authorization header when no apiKey is set (local Ollama)", async () => {
    const fetchImpl = okFetch(completion('{"score": 50, "rationale": "ok"}'));

    await build(fetchImpl, { apiKey: undefined, baseUrl: "http://localhost:11434/v1" }).judge(
      makeRequest(),
      new AbortController().signal,
    );

    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("tolerates free-tier model quirks: markdown fences, prose around the JSON, numeric-string score", async () => {
    const fenced = okFetch(completion('```json\n{"score": "85", "rationale": "Good."}\n```'));
    expect((await build(fenced).judge(makeRequest(), new AbortController().signal)).score).toBe(85);

    const prose = okFetch(completion('Here you go: {"score": 40, "rationale": "Meh."} Hope it helps!'));
    expect((await build(prose).judge(makeRequest(), new AbortController().signal)).score).toBe(40);
  });

  it("defaults token counts to 0 when the provider omits usage", async () => {
    const fetchImpl = okFetch(completion('{"score": 50, "rationale": "ok"}', { usage: undefined }));

    const verdict = await build(fetchImpl).judge(makeRequest(), new AbortController().signal);

    expect(verdict.promptTokens).toBe(0);
    expect(verdict.completionTokens).toBe(0);
  });

  it("throws LLMProviderError carrying the HTTP status on a non-2xx response (e.g. 429 free-tier rate limit)", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));

    const err = await build(fetchImpl as never)
      .judge(makeRequest(), new AbortController().signal)
      .catch((e) => e);

    expect(err).toBeInstanceOf(LLMProviderError);
    expect(err.status).toBe(429);
  });

  it.each([
    ["no choices", { model: "m", choices: [] }],
    ["content is not JSON", completion("I cannot do that")],
    ["score out of range", completion('{"score": 150, "rationale": "x"}')],
    ["score missing", completion('{"rationale": "x"}')],
    ["rationale empty", completion('{"score": 50, "rationale": "  "}')],
  ])("throws LLMResponseParseError when %s", async (_label, body) => {
    await expect(build(okFetch(body)).judge(makeRequest(), new AbortController().signal)).rejects.toBeInstanceOf(
      LLMResponseParseError,
    );
  });
});
