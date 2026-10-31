import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AskThread } from "@echo/contracts";
import { describe, expect, it } from "vitest";
import {
  createDemoPolicy,
  demoReadonly,
  demoUsageTokens,
  recordedExamples,
  resolveDemoLimits,
  resolveDemoStatic,
} from "./demo";

function testPolicy() {
  let now = Date.parse("2026-10-31T09:00:00.000Z");
  const policy = createDemoPolicy(resolveDemoLimits({}), () => now);
  return { policy, advance: (ms: number) => (now += ms) };
}

describe("demo policy", () => {
  it("resolves defaults and honors env overrides", () => {
    expect(resolveDemoLimits({})).toEqual({
      askPerMinute: 5,
      answerPerMinute: 20,
      maxAsksPerDay: 200,
      maxAnswersPerDay: 500,
      maxTokensPerDay: 5_000_000,
    });
    expect(
      resolveDemoLimits({ ECHO_DEMO_ASK_PER_MIN: "2", ECHO_DEMO_MAX_TOKENS_DAY: "bogus" }),
    ).toMatchObject({ askPerMinute: 2, maxTokensPerDay: 5_000_000 });
  });

  it("rate-limits asks per IP with a sliding window", () => {
    const { policy, advance } = testPolicy();
    for (let i = 0; i < 5; i++) expect(policy.admitAsk("1.2.3.4")).toEqual({ ok: true });
    const limited = policy.admitAsk("1.2.3.4");
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.reason).toBe("rate_limited");
      expect(limited.retryAfterMs).toBeGreaterThan(0);
    }
    // Another IP is unaffected.
    expect(policy.admitAsk("5.6.7.8")).toEqual({ ok: true });
    advance(61_000);
    expect(policy.admitAsk("1.2.3.4")).toEqual({ ok: true });
  });

  it("rate-limits answers per IP at the higher budget", () => {
    const { policy } = testPolicy();
    for (let i = 0; i < 20; i++) expect(policy.admitAnswer("1.2.3.4").ok).toBe(true);
    const limited = policy.admitAnswer("1.2.3.4");
    expect(limited).toMatchObject({ ok: false, reason: "rate_limited" });
  });

  it("exhausts the daily ask budget and resets on day rollover", () => {
    const { policy, advance } = testPolicy();
    for (let i = 0; i < 200; i++) {
      // Spread across IPs so the per-minute bucket never trips first.
      expect(policy.admitAsk(`10.0.0.${i % 250}`).ok).toBe(true);
      advance(20_000);
    }
    // Same UTC day: the 201st attempt exhausts.
    const exhausted = policy.admitAsk("10.9.9.9");
    expect(exhausted).toEqual({ ok: false, reason: "budget_exhausted", retryAfterMs: null });
    advance(24 * 3_600_000);
    expect(policy.admitAsk("10.9.9.9")).toEqual({ ok: true });
  });

  it("exhausts on the token cap", () => {
    const { policy } = testPolicy();
    policy.recordTokens(5_000_000);
    expect(policy.admitAsk("1.2.3.4")).toMatchObject({ ok: false, reason: "budget_exhausted" });
    expect(policy.admitAnswer("1.2.3.4")).toMatchObject({ ok: false, reason: "budget_exhausted" });
  });

  it("ignores non-positive token records", () => {
    const { policy } = testPolicy();
    policy.recordTokens(0);
    policy.recordTokens(Number.NaN);
    expect(policy.admitAsk("1.2.3.4")).toEqual({ ok: true });
  });
});

describe("demo usage tokens", () => {
  it("sums prompt and completion, ignoring nullish usage", () => {
    expect(demoUsageTokens({ promptTokens: 10, completionTokens: 20 })).toBe(30);
    expect(demoUsageTokens(null)).toBe(0);
    expect(demoUsageTokens(undefined)).toBe(0);
  });
});

describe("demo readonly body", () => {
  it("pins the readonly_demo error shape", () => {
    expect(demoReadonly()).toEqual({
      error: { code: "readonly_demo", message: "not available in the read-only demo" },
    });
  });
});

describe("recorded examples", () => {
  function thread(texts: Array<{ role: "user" | "assistant"; text: string }>): AskThread {
    return {
      schemaVersion: 1,
      sessionId: "ses_demo",
      updatedAt: "2026-10-31T00:00:00.000Z",
      messages: texts.map((entry, index) => ({
        id: `msg_${index}`,
        role: entry.role,
        text: entry.text,
        cardId: null,
        response: null,
        createdAt: "2026-10-31T00:00:00.000Z",
      })),
    };
  }

  it("lists user questions deduped and capped", () => {
    const examples = recordedExamples(
      thread([
        { role: "user", text: "Why was it deleted?" },
        { role: "assistant", text: "Because reasons." },
        { role: "user", text: "Why was it deleted?" },
        { role: "user", text: "  " },
        { role: "user", text: "What changed?" },
        { role: "user", text: "How do discounts work?" },
      ]),
      2,
    );
    expect(examples).toEqual(["Why was it deleted?", "What changed?"]);
  });
});

describe("demo static files", () => {
  function seedWeb(): string {
    const dir = mkdtempSync(join(tmpdir(), "echo-demo-web-"));
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html></html>");
    writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
    return dir;
  }

  it("serves exact files with content types", () => {
    const dir = seedWeb();
    expect(resolveDemoStatic(dir, "/")).toMatchObject({
      file: join(dir, "index.html"),
      contentType: "text/html; charset=utf-8",
      immutable: false,
    });
    expect(resolveDemoStatic(dir, "/assets/app.js?x=1")).toMatchObject({
      file: join(dir, "assets", "app.js"),
      contentType: "text/javascript; charset=utf-8",
      immutable: true,
    });
  });

  it("falls back to index.html for extensionless routes", () => {
    const dir = seedWeb();
    expect(resolveDemoStatic(dir, "/sessions/abc")?.file).toBe(join(dir, "index.html"));
  });

  it("404s missing assets and escapes", () => {
    const dir = seedWeb();
    expect(resolveDemoStatic(dir, "/assets/missing.js")).toBeNull();
    expect(resolveDemoStatic(dir, "/../demo.ts")).toBeNull();
    expect(resolveDemoStatic(dir, "/%2e%2e/%2e%2e/x")).toBeNull();
    expect(resolveDemoStatic(dir, "/%E0%A4%A")).toBeNull();
  });
});
