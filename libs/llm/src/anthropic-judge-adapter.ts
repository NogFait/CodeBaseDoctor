import Anthropic from "@anthropic-ai/sdk";
import type { JudgeRequest, JudgeVerdict, LLMJudgePort } from "@cbd/analysis";

/**
 * AnthropicJudgeAdapter — the ONLY component in the system allowed to talk to
 * an LLM provider SDK. See design: "The five ports" / "LLM determinism".
 *
 * Model pin deviation from the design's literal "temperature: 0, top_p: 1"
 * wording: `claude-opus-5` / `claude-sonnet-5` / `claude-opus-4-8` / `claude-opus-4-7`
 * all REJECT the `temperature` parameter outright (400 invalid_request_error) —
 * sampling params were removed starting with the 4.7-and-later model family.
 * `temperature: 0` is only accepted on `claude-sonnet-4-6` / `claude-opus-4-6`
 * and older. Since the design's determinism requirement (decision-adjacent,
 * "Deferred Risks: LLM determinism") explicitly wants fixed decoding via
 * `temperature: 0`, and the orchestrator's task instructions explicitly ask
 * for a test asserting `temperature: 0` on the outgoing request, this adapter
 * pins to `claude-sonnet-4-6` rather than the latest model — the newest model
 * that still honors a literal temperature parameter. Flagged as a deviation
 * in apply-progress; revisit if the design's determinism story is ever
 * updated to use `output_config.effort` + omitted `thinking` instead.
 */
const DEFAULT_MODEL_ID = "claude-sonnet-4-6";

const VERDICT_TOOL_NAME = "submit_verdict";

const VERDICT_TOOL: Anthropic.Tool = {
  name: VERDICT_TOOL_NAME,
  description:
    "Submit the category judgment as a structured verdict. Call this exactly once with your final score and rationale.",
  input_schema: {
    type: "object",
    properties: {
      score: {
        type: "integer",
        description: "Integer score from 0 to 100 (inclusive) for this category.",
      },
      rationale: {
        type: "string",
        description: "Written rationale explaining the score. Must be non-empty.",
      },
    },
    required: ["score", "rationale"],
    additionalProperties: false,
  },
  strict: true,
};

/**
 * Thrown when the Anthropic response cannot be mapped to a JudgeVerdict —
 * e.g. no `submit_verdict` tool_use block, or a malformed/missing input
 * shape. Keeps a raw SDK/parse exception from propagating past this adapter.
 */
export class LLMResponseParseError extends Error {
  constructor(
    public readonly reason: string,
    public readonly rawResponseId?: string,
  ) {
    super(`AnthropicJudgeAdapter: could not parse a JudgeVerdict from the response (${reason})`);
    this.name = "LLMResponseParseError";
  }
}

export interface AnthropicJudgeAdapterOptions {
  /**
   * Injected Anthropic client — used by tests to substitute a fake that
   * returns scripted responses without a real network call or API key.
   * Defaults to a real client (reads ANTHROPIC_API_KEY from the
   * environment) only when the adapter is actually instantiated by DI.
   */
  client?: Anthropic;
  modelId?: string;
}

function buildSystemPrompt(req: JudgeRequest): string {
  // Anthropic's wire protocol has no "rubricId"/"rubricVersion" field — the
  // design's determinism story ("prompt template hashed into rubricVersion")
  // requires these to actually reach the model, so they're appended to the
  // system prompt here rather than silently dropped at the port boundary.
  return `${req.systemPrompt}\n\n[rubric: ${req.rubricId} v${req.rubricVersion}]`;
}

function parseVerdict(response: Anthropic.Message, req: JudgeRequest): JudgeVerdict {
  const toolUseBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === VERDICT_TOOL_NAME,
  );

  if (!toolUseBlock) {
    throw new LLMResponseParseError(
      `no "${VERDICT_TOOL_NAME}" tool_use block in response (stop_reason: ${response.stop_reason ?? "unknown"})`,
      response.id,
    );
  }

  const input = toolUseBlock.input;
  if (typeof input !== "object" || input === null) {
    throw new LLMResponseParseError("tool_use input was not an object", response.id);
  }

  const { score, rationale } = input as Record<string, unknown>;

  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) {
    throw new LLMResponseParseError(`"score" must be a number in [0,100], got ${JSON.stringify(score)}`, response.id);
  }
  if (typeof rationale !== "string" || rationale.trim().length === 0) {
    throw new LLMResponseParseError(`"rationale" must be a non-empty string, got ${JSON.stringify(rationale)}`, response.id);
  }

  return {
    score,
    rationale,
    modelId: response.model,
    promptTokens: response.usage.input_tokens,
    completionTokens: response.usage.output_tokens,
  };
}

export class AnthropicJudgeAdapter implements LLMJudgePort {
  private readonly client: Anthropic;
  private readonly modelId: string;

  constructor(options: AnthropicJudgeAdapterOptions = {}) {
    // No apiKey passed explicitly — the SDK resolves ANTHROPIC_API_KEY (or an
    // `ant auth login` profile) from the environment lazily, at request time,
    // not at construction time. Constructing this with no key set (as in
    // this sandbox) does not throw; it would only throw if judge() were
    // actually called for real, which tests never do (they inject `client`).
    this.client = options.client ?? new Anthropic();
    this.modelId = options.modelId ?? DEFAULT_MODEL_ID;
  }

  async judge(req: JudgeRequest, signal: AbortSignal): Promise<JudgeVerdict> {
    const response = await this.client.messages.create(
      {
        model: this.modelId,
        max_tokens: req.maxOutputTokens,
        temperature: 0,
        system: buildSystemPrompt(req),
        messages: [{ role: "user", content: req.userPrompt }],
        tools: [VERDICT_TOOL],
        tool_choice: { type: "tool", name: VERDICT_TOOL_NAME },
      },
      { signal },
    );

    return parseVerdict(response, req);
  }
}
