import type { JudgeRequest, JudgeVerdict, LLMJudgePort } from "@cbd/analysis";
import { LLMResponseParseError } from "./anthropic-judge-adapter";

/**
 * OpenAICompatibleJudgeAdapter — an LLMJudgePort over any OpenAI-compatible
 * `POST {baseUrl}/chat/completions` endpoint. One adapter, many free options:
 *
 *   Groq        https://api.groq.com/openai/v1                         (free tier)
 *   Gemini      https://generativelanguage.googleapis.com/v1beta/openai (free tier)
 *   OpenRouter  https://openrouter.ai/api/v1                           (":free" models)
 *   Ollama      http://localhost:11434/v1                              (local, no key)
 *
 * Uses plain `fetch` (injectable for tests) — no SDK, no new dependency.
 * Free-tier models don't reliably support tool-calling, so the verdict is
 * requested as JSON (`response_format: json_object`) and parsed leniently.
 */

/** Non-2xx from the provider (e.g. 429 when the free-tier quota is hit). */
export class LLMProviderError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`OpenAICompatibleJudgeAdapter: provider responded ${status}: ${body.slice(0, 200)}`);
    this.name = "LLMProviderError";
  }
}

export interface OpenAICompatibleJudgeAdapterOptions {
  baseUrl: string;
  modelId: string;
  /** Omit for providers that need none (local Ollama). */
  apiKey?: string;
  /** Injected in tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

const JSON_INSTRUCTION =
  'Respond with ONLY a JSON object, no prose and no markdown: {"score": <integer 0-100>, "rationale": "<non-empty explanation>"}.';

function buildSystemPrompt(req: JudgeRequest): string {
  return `${req.systemPrompt}\n\n[rubric: ${req.rubricId} v${req.rubricVersion}]\n\n${JSON_INSTRUCTION}`;
}

/** Pull the first `{...}` object out of free text (handles ```json fences / chatter). */
function extractJsonObject(content: string, id?: string): Record<string, unknown> {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new LLMResponseParseError("completion content contained no JSON object", id);
  }
  try {
    const parsed: unknown = JSON.parse(content.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new LLMResponseParseError("completion content was not valid JSON", id);
  }
}

interface ChatCompletion {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatibleJudgeAdapter implements LLMJudgePort {
  private readonly endpoint: string;
  private readonly modelId: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleJudgeAdapterOptions) {
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.modelId = options.modelId;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async judge(req: JudgeRequest, signal: AbortSignal): Promise<JudgeVerdict> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: this.modelId,
        temperature: 0,
        max_tokens: req.maxOutputTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt(req) },
          { role: "user", content: req.userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      throw new LLMProviderError(response.status, await response.text());
    }

    return this.parseVerdict((await response.json()) as ChatCompletion);
  }

  private parseVerdict(completion: ChatCompletion): JudgeVerdict {
    const content = completion.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new LLMResponseParseError("no message content in completion", completion.id);
    }

    const { score: rawScore, rationale } = extractJsonObject(content, completion.id);
    // Free-tier models sometimes quote numbers ("85"); accept that, nothing sloppier.
    const score = typeof rawScore === "string" && rawScore.trim() !== "" ? Number(rawScore) : rawScore;

    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) {
      throw new LLMResponseParseError(`"score" must be a number in [0,100], got ${JSON.stringify(rawScore)}`, completion.id);
    }
    if (typeof rationale !== "string" || rationale.trim().length === 0) {
      throw new LLMResponseParseError(`"rationale" must be a non-empty string, got ${JSON.stringify(rationale)}`, completion.id);
    }

    return {
      score,
      rationale,
      modelId: completion.model ?? this.modelId,
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
    };
  }
}
