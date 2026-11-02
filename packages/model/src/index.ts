import type { Dispatcher } from "undici";
import { Agent } from "undici";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Reasoning tokens consume the output budget, so default generously. */
  maxTokens: number;
  /** Reasoning effort cap, sent as top-level `reasoning_effort`. Unset means
   *  the model decides. Muse Spark rejects "none". */
  reasoningEffort?: string;
}

export type ModelErrorCode =
  | "missing_api_key"
  | "model_error"
  | "invalid_response"
  | "output_budget_exhausted";

export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly status: number | null;
  constructor(code: ModelErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "ModelError";
    this.code = code;
    this.status = status;
  }
}

/** Accepted `reasoning_effort` levels (Meta Model API, chat completions).
 *  "none" disables reasoning, which Muse Spark rejects — excluded here so a
 *  misconfiguration fails fast locally instead of as an API 400. "max" is a
 *  standard-tier level the API gates per model; passing it through lets the
 *  API decide rather than the client. */
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

function assertReasoningEffort(value: string): asserts value is ReasoningEffort {
  if (!(REASONING_EFFORTS as readonly string[]).includes(value)) {
    throw new ModelError(
      "model_error",
      `invalid reasoning effort ${JSON.stringify(value)} (want one of ${REASONING_EFFORTS.join("|")})`,
    );
  }
}

export function modelConfigFromEnv(env: NodeJS.ProcessEnv): ModelConfig {
  const explicit = (env.ECHO_MODEL_PROVIDER ?? "").toLowerCase();
  const provider =
    explicit === "baseten" || explicit === "meta"
      ? explicit
      : (env.BASETEN_API_KEY ?? "").length > 0
        ? "baseten"
        : "meta";
  if (provider === "baseten") {
    const apiKey = env.BASETEN_API_KEY ?? "";
    if (apiKey.length === 0) {
      if (explicit === "" && (env.META_API_KEY ?? "").length > 0) {
        return modelConfigFromEnv({ ...env, ECHO_MODEL_PROVIDER: "meta" });
      }
      throw new ModelError("missing_api_key", "BASETEN_API_KEY is not set");
    }
    const maxTokens = Number.parseInt(env.BASETEN_MAX_TOKENS ?? env.META_MAX_TOKENS ?? "", 10);
    const reasoningEffort = env.BASETEN_REASONING_EFFORT ?? env.META_REASONING_EFFORT ?? "";
    if (reasoningEffort !== "") assertReasoningEffort(reasoningEffort);
    return {
      baseUrl: env.BASETEN_BASE_URL ?? "https://inference.baseten.co/v1",
      apiKey,
      model: env.BASETEN_MODEL_ID ?? "meta-models/muse-spark-open-1026",
      maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 2048,
      ...(reasoningEffort === "" ? {} : { reasoningEffort }),
    };
  }
  const apiKey = env.META_API_KEY ?? "";
  if (apiKey.length === 0) {
    throw new ModelError("missing_api_key", "META_API_KEY is not set");
  }
  const maxTokens = Number.parseInt(env.META_MAX_TOKENS ?? "", 10);
  const reasoningEffort = env.META_REASONING_EFFORT ?? "";
  if (reasoningEffort !== "") assertReasoningEffort(reasoningEffort);
  return {
    baseUrl: env.META_BASE_URL ?? "https://api.meta.ai/v1",
    apiKey,
    model: env.META_MODEL_ID ?? "muse-spark-1.3-contributor",
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 2048,
    ...(reasoningEffort === "" ? {} : { reasoningEffort }),
  };
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

export interface ChatCompletionResult {
  content: string | null;
  finishReason: string | null;
  usage: ChatUsage | null;
}

type FetchImpl = typeof fetch;

interface ChatCompletionsOptions {
  fetchImpl?: FetchImpl;
  signal?: AbortSignal;
  /** Per-call reasoning cap; beats ModelConfig.reasoningEffort when set. */
  reasoningEffort?: string;
}

/**
 * Workaround for broken-IPv6 hosts (VPNs, tunnels, misconfigured ISPs):
 * undici can fail the whole request on a dead v6 route instead of falling
 * back to v4 the way curl and browsers do. On a transport-level fetch
 * rejection only (never on HTTP error statuses, which take the normal
 * error path below), retry once with an IPv4-pinned dispatcher and report
 * the ORIGINAL error if both attempts fail.
 */
async function fetchWithIpv4Fallback(
  fetchImpl: (url: string, init?: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>,
  url: string,
  init: RequestInit & { dispatcher?: Dispatcher },
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    const fallback = new Agent({ connect: { family: 4 } });
    try {
      return await fetchImpl(url, { ...init, dispatcher: fallback });
    } catch {
      throw error;
    } finally {
      await fallback.close().catch(() => {});
    }
  }
}

/** Minimal Meta (OpenAI-compatible) chat-completions call. No retries: the
 *  caller owns budget and retry policy and can inspect ModelError.code. */
export async function chatCompletions(
  config: ModelConfig,
  messages: ChatMessage[],
  options: ChatCompletionsOptions = {},
): Promise<ChatCompletionResult> {
  try {
    return await chatCompletionsOnce(config, messages, options);
  } catch (error) {
    if (
      error instanceof ModelError &&
      error.code === "model_error" &&
      isBasetenConfig(config) &&
      options.signal?.aborted !== true &&
      (process.env.META_API_KEY ?? "").length > 0
    ) {
      let fallback: ModelConfig;
      try {
        fallback = modelConfigFromEnv({ ...process.env, ECHO_MODEL_PROVIDER: "meta" });
      } catch {
        throw error;
      }
      return await chatCompletionsOnce(fallback, messages, options);
    }
    throw error;
  }
}

async function chatCompletionsOnce(
  config: ModelConfig,
  messages: ChatMessage[],
  options: ChatCompletionsOptions = {},
): Promise<ChatCompletionResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const effort = options.reasoningEffort ?? config.reasoningEffort;
  if (effort !== undefined) assertReasoningEffort(effort);
  let response: Response;
  try {
    response = await fetchWithIpv4Fallback(fetchImpl, `${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: config.maxTokens,
        ...(effort === undefined ? {} : { reasoning_effort: effort }),
        messages,
      }),
      signal: options.signal,
    });
  } catch (error) {
    throw new ModelError("model_error", error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ModelError(
      "model_error",
      `model API ${response.status}: ${body.slice(0, 200)}`,
      response.status,
    );
  }
  let parsed: unknown;
  try {
    parsed = (await response.json()) as unknown;
  } catch {
    throw new ModelError("invalid_response", "model API returned non-JSON");
  }
  const choice = (
    parsed as {
      choices?: Array<{
        finish_reason?: unknown;
        message?: { content?: unknown };
      }>;
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        completion_tokens_details?: { reasoning_tokens?: unknown };
      };
    }
  ).choices?.[0];
  if (choice === undefined) throw new ModelError("invalid_response", "no choices in response");
  const content = typeof choice.message?.content === "string" ? choice.message.content : null;
  const wire = parsed as {
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      completion_tokens_details?: { reasoning_tokens?: unknown };
    };
  };
  const wireUsage = wire.usage;
  const usage: ChatUsage | null =
    wireUsage !== undefined &&
    typeof wireUsage.prompt_tokens === "number" &&
    typeof wireUsage.completion_tokens === "number"
      ? {
          promptTokens: wireUsage.prompt_tokens,
          completionTokens: wireUsage.completion_tokens,
          reasoningTokens:
            typeof wireUsage.completion_tokens_details?.reasoning_tokens === "number"
              ? wireUsage.completion_tokens_details.reasoning_tokens
              : 0,
        }
      : null;
  return {
    content,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    usage,
  };
}

interface RequestJsonOptions extends ChatCompletionsOptions {
  /** Extra tokens for one retry when the first call exhausts the budget. */
  retryMaxTokens?: number;
}

/**
 * Structured-output call. `parse` validates the decoded JSON (pass a
 * zod `.parse`-style function). A `length` finish with null content means
 * reasoning consumed the budget — retried once with a larger budget when
 * `retryMaxTokens` is set, else reported as output_budget_exhausted.
 */
export async function requestJson<T>(
  config: ModelConfig,
  messages: ChatMessage[],
  parse: (value: unknown) => T,
  options: RequestJsonOptions = {},
): Promise<{ value: T; usage: ChatUsage | null }> {
  const attempts =
    options.retryMaxTokens !== undefined && options.retryMaxTokens > config.maxTokens ? 2 : 1;
  let lastError: ModelError | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const active: ModelConfig =
      attempt === 1 && options.retryMaxTokens !== undefined
        ? { ...config, maxTokens: options.retryMaxTokens }
        : config;
    const result = await chatCompletions(active, messages, options);
    if (result.content === null) {
      lastError = new ModelError(
        "output_budget_exhausted",
        `finish=${result.finishReason ?? "unknown"} with null content; reasoning likely consumed the budget`,
      );
      continue;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(result.content) as unknown;
    } catch {
      throw new ModelError("invalid_response", "model content was not JSON");
    }
    try {
      return { value: parse(decoded), usage: result.usage };
    } catch (error) {
      throw new ModelError(
        "invalid_response",
        `schema validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw lastError ?? new ModelError("output_budget_exhausted", "no usable completion");
}

export function isBasetenConfig(config: ModelConfig): boolean {
  return config.baseUrl.includes("baseten") || config.model.includes("muse-spark-open");
}

export function getMetaFallbackConfig(
  env: NodeJS.ProcessEnv,
  primary: ModelConfig,
): ModelConfig | null {
  if (!isBasetenConfig(primary)) return null;
  if ((env.META_API_KEY ?? "").length === 0) return null;
  return modelConfigFromEnv({ ...env, ECHO_MODEL_PROVIDER: "meta" });
}

function shouldFallbackToMeta(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return false;
  return error instanceof ModelError && error.code === "model_error";
}

export async function chatCompletionsWithFallback(
  primary: ModelConfig,
  fallback: ModelConfig | null,
  messages: ChatMessage[],
  options: ChatCompletionsOptions = {},
): Promise<ChatCompletionResult> {
  try {
    return await chatCompletions(primary, messages, options);
  } catch (error) {
    if (fallback !== null && shouldFallbackToMeta(error, options.signal)) {
      return await chatCompletions(fallback, messages, options);
    }
    throw error;
  }
}

export async function requestJsonWithFallback<T>(
  primary: ModelConfig,
  fallback: ModelConfig | null,
  messages: ChatMessage[],
  parse: (value: unknown) => T,
  options: RequestJsonOptions = {},
): Promise<{ value: T; usage: ChatUsage | null }> {
  try {
    return await requestJson(primary, messages, parse, options);
  } catch (error) {
    if (fallback !== null && shouldFallbackToMeta(error, options.signal)) {
      return await requestJson(fallback, messages, parse, options);
    }
    throw error;
  }
}
