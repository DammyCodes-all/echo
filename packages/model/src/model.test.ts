import { describe, expect, it, vi } from "vitest";
import {
  chatCompletions,
  chatCompletionsWithFallback,
  getMetaFallbackConfig,
  isBasetenConfig,
  type ModelConfig,
  ModelError,
  modelConfigFromEnv,
  requestJson,
  requestJsonWithFallback,
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

  it("selects the Baseten open-weights path when requested", () => {
    const cfg = modelConfigFromEnv({
      ECHO_MODEL_PROVIDER: "baseten",
      BASETEN_API_KEY: "bk",
    });
    expect(cfg.baseUrl).toBe("https://inference.baseten.co/v1");
    expect(cfg.model).toBe("meta-models/muse-spark-open-1026");
    expect(() => modelConfigFromEnv({ ECHO_MODEL_PROVIDER: "baseten" })).toThrowError(
      /BASETEN_API_KEY/,
    );
  });

  it("defaults to Baseten when its key is present, else falls back to Meta", () => {
    expect(modelConfigFromEnv({ BASETEN_API_KEY: "bk" }).model).toBe(
      "meta-models/muse-spark-open-1026",
    );
    expect(modelConfigFromEnv({ BASETEN_API_KEY: "bk", META_API_KEY: "k" }).baseUrl).toBe(
      "https://inference.baseten.co/v1",
    );
    expect(modelConfigFromEnv({ META_API_KEY: "k" }).model).toBe("muse-spark-1.3-contributor");
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

  it("retries a transport failure once with an IPv4 fallback dispatcher", async () => {
    // Broken-IPv6 hosts: undici can fail the whole request on a dead v6
    // route instead of falling back to v4. The retry must carry a
    // dispatcher; success-path callers never see one.
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new TypeError("fetch failed");
      })
      .mockImplementationOnce(async () => jsonResponse(completion("hello")));
    const result = await chatCompletions(config, [{ role: "user", content: "hi" }], {
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.content).toBe("hello");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, retryOptions] = fetchImpl.mock.calls[1] as unknown as [
      string,
      RequestInit & { dispatcher?: unknown },
    ];
    expect(retryOptions).toMatchObject({ dispatcher: expect.anything() });
  });

  it("reports the original error when the IPv4 fallback also fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      chatCompletions(config, [{ role: "user", content: "q" }], {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "model_error", message: "fetch failed" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("sends reasoning_effort from config and lets the call override it", async () => {
    const withEffort: ModelConfig = { ...config, reasoningEffort: "low" };
    const fetchImpl = vi.fn(async () => jsonResponse(completion("hello")));
    await chatCompletions(withEffort, [{ role: "user", content: "hi" }], {
      fetchImpl: fetchImpl as typeof fetch,
    });
    const [, options] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toMatchObject({ reasoning_effort: "low" });

    const override = vi.fn(async () => jsonResponse(completion("hello")));
    await chatCompletions(withEffort, [{ role: "user", content: "hi" }], {
      fetchImpl: override as typeof fetch,
      reasoningEffort: "medium",
    });
    const [, overrideOptions] = override.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(overrideOptions.body))).toMatchObject({ reasoning_effort: "medium" });
  });

  it("omits reasoning_effort when unset and rejects unknown levels", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(completion("hello")));
    await chatCompletions(config, [{ role: "user", content: "hi" }], {
      fetchImpl: fetchImpl as typeof fetch,
    });
    const [, options] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect("reasoning_effort" in JSON.parse(String(options.body))).toBe(false);

    expect(() =>
      modelConfigFromEnv({ META_API_KEY: "k", META_REASONING_EFFORT: "none" }),
    ).toThrowError(ModelError);
    expect(
      modelConfigFromEnv({ META_API_KEY: "k", META_REASONING_EFFORT: "low" }).reasoningEffort,
    ).toBe("low");
    await expect(
      chatCompletions(config, [{ role: "user", content: "hi" }], {
        fetchImpl: fetchImpl as typeof fetch,
        reasoningEffort: "bogus",
      }),
    ).rejects.toThrowError(ModelError);
  });

  it("retries with Meta fallback after a Baseten model_error", async () => {
    const primary: ModelConfig = {
      baseUrl: "https://inference.baseten.co/v1",
      apiKey: "bk",
      model: "meta-models/muse-spark-open-1026",
      maxTokens: 64,
    };
    const fallback: ModelConfig = { ...config };
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => new Response("bad", { status: 500 }))
      .mockImplementationOnce(async () => jsonResponse(completion(JSON.stringify({ ok: 1 }))));
    const { value } = await requestJsonWithFallback(
      primary,
      fallback,
      [{ role: "user", content: "q" }],
      (v) => v as { ok: number },
      { fetchImpl: fetchImpl as typeof fetch },
    );
    expect(value).toEqual({ ok: 1 });
    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      "https://inference.baseten.co/v1/chat/completions",
      "https://api.meta.ai/v1/chat/completions",
    ]);
  });

  it("does not fallback on invalid_response or when primary is Meta", async () => {
    const baseten: ModelConfig = {
      baseUrl: "https://inference.baseten.co/v1",
      apiKey: "bk",
      model: "meta-models/muse-spark-open-1026",
      maxTokens: 64,
    };
    const badJson = vi.fn(async () => jsonResponse("not-json"));
    await expect(
      requestJsonWithFallback(baseten, config, [{ role: "user", content: "q" }], (v) => v, {
        fetchImpl: badJson as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(badJson).toHaveBeenCalledTimes(1);

    expect(isBasetenConfig(baseten)).toBe(true);
    expect(isBasetenConfig(config)).toBe(false);
    expect(getMetaFallbackConfig({ META_API_KEY: "k" }, config)).toBeNull();
    expect(getMetaFallbackConfig({}, baseten)).toBeNull();
    expect(getMetaFallbackConfig({ META_API_KEY: "k" }, baseten)?.model).toBe(
      "muse-spark-1.3-contributor",
    );
  });

  it("chatCompletionsWithFallback falls back once on transport model_error", async () => {
    const primary: ModelConfig = {
      baseUrl: "https://inference.baseten.co/v1",
      apiKey: "bk",
      model: "meta-models/muse-spark-open-1026",
      maxTokens: 64,
    };
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new TypeError("fetch failed");
      })
      .mockImplementationOnce(async () => {
        throw new TypeError("fetch failed");
      })
      .mockImplementationOnce(async () => jsonResponse(completion("hi")));
    const result = await chatCompletionsWithFallback(
      primary,
      config,
      [{ role: "user", content: "q" }],
      {
        fetchImpl: fetchImpl as typeof fetch,
      },
    );
    expect(result.content).toBe("hi");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("chatCompletions auto-fallbacks Baseten->Meta on model_error when META key exists", async () => {
    const primary: ModelConfig = {
      baseUrl: "https://inference.baseten.co/v1",
      apiKey: "bk",
      model: "meta-models/muse-spark-open-1026",
      maxTokens: 64,
    };
    const prev = process.env.META_API_KEY;
    process.env.META_API_KEY = "k";
    try {
      const fetchImpl = vi
        .fn()
        .mockImplementationOnce(async () => new Response("bad", { status: 500 }))
        .mockImplementationOnce(async () => jsonResponse(completion("hi")));
      const result = await chatCompletions(primary, [{ role: "user", content: "q" }], {
        fetchImpl: fetchImpl as typeof fetch,
      });
      expect(result.content).toBe("hi");
      const urls = fetchImpl.mock.calls.map(([url]) => String(url));
      expect(urls).toEqual([
        "https://inference.baseten.co/v1/chat/completions",
        "https://api.meta.ai/v1/chat/completions",
      ]);
    } finally {
      if (prev === undefined) delete process.env.META_API_KEY;
      else process.env.META_API_KEY = prev;
    }
  });
});
