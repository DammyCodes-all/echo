import { describe, expect, it, vi } from "vitest";
import {
  chatCompletions,
  type ModelConfig,
  ModelError,
  modelConfigFromEnv,
  requestJson,
} from "./index";

const config: ModelConfig = {
  baseUrl: "https://api.meta.ai/v1",
  apiKey: "test-key",
  model: "muse-spark-1.3-contributor",
  maxTokens: 64,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function completion(content: unknown, finish = "stop"): unknown {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: config.model,
    choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content } }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 5 },
    },
  };
}

describe("model client", () => {
  it("rejects a missing API key before any request", () => {
    expect(() => modelConfigFromEnv({})).toThrowError(ModelError);
    const fetchImpl = vi.fn();
    expect(() => modelConfigFromEnv({ META_API_KEY: "k" })).not.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("parses content, finish reason and usage", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(completion("hello")));
    const result = await chatCompletions(config, [{ role: "user", content: "hi" }], {
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.content).toBe("hello");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 20, reasoningTokens: 5 });
    const [calledUrl, calledOptions] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe("https://api.meta.ai/v1/chat/completions");
    expect(calledOptions.headers).toMatchObject({ Authorization: "Bearer test-key" });
  });

  it("validates structured output with the caller parser", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(completion(JSON.stringify({ answer: "a", citations: ["1"] }))),
    );
    const { value } = await requestJson(
      config,
      [{ role: "user", content: "q" }],
      (decoded) => {
        const record = decoded as { answer?: unknown };
        if (typeof record.answer !== "string") throw new Error("bad answer");
        return { answer: record.answer };
      },
      { fetchImpl: fetchImpl as typeof fetch },
    );
    expect(value).toEqual({ answer: "a" });
  });

  it("reports output_budget_exhausted on length with null content", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(completion(null, "length")));
    await expect(
      requestJson(config, [{ role: "user", content: "q" }], (value) => value, {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "output_budget_exhausted" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries once with a larger budget when configured", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(completion(null, "length")));
    await expect(
      requestJson(config, [{ role: "user", content: "q" }], (value) => value, {
        fetchImpl: fetchImpl as typeof fetch,
        retryMaxTokens: 256,
      }),
    ).rejects.toMatchObject({ code: "output_budget_exhausted" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("wraps HTTP failures as model_error with status", async () => {
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 401 }));
    await expect(
      chatCompletions(config, [{ role: "user", content: "q" }], {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "model_error", status: 401 });
  });
});
