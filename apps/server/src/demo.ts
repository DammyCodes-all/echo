// Demo-mode policy: per-IP rate limits plus global daily budgets. All state
// is in memory: a restart resets every counter, which ARCH §18 allows
// (the caps are conservative either way).

import { existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import type { AskThread } from "@echo/contracts";

export interface DemoLimits {
  askPerMinute: number;
  answerPerMinute: number;
  maxAsksPerDay: number;
  maxAnswersPerDay: number;
  maxTokensPerDay: number;
}

const DEFAULTS: DemoLimits = {
  askPerMinute: 5,
  answerPerMinute: 20,
  maxAsksPerDay: 200,
  maxAnswersPerDay: 500,
  // Token proxy for the dollar cap (ARCH §18): ~2x the count-implied max.
  maxTokensPerDay: 5_000_000,
};

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveDemoLimits(env: NodeJS.ProcessEnv = process.env): DemoLimits {
  return {
    askPerMinute: envInt(env, "ECHO_DEMO_ASK_PER_MIN", DEFAULTS.askPerMinute),
    answerPerMinute: envInt(env, "ECHO_DEMO_ANSWER_PER_MIN", DEFAULTS.answerPerMinute),
    maxAsksPerDay: envInt(env, "ECHO_DEMO_MAX_ASKS_DAY", DEFAULTS.maxAsksPerDay),
    maxAnswersPerDay: envInt(env, "ECHO_DEMO_MAX_ANSWERS_DAY", DEFAULTS.maxAnswersPerDay),
    maxTokensPerDay: envInt(env, "ECHO_DEMO_MAX_TOKENS_DAY", DEFAULTS.maxTokensPerDay),
  };
}

export type DemoAdmission =
  | { ok: true }
  | { ok: false; reason: "rate_limited" | "budget_exhausted"; retryAfterMs: number | null };

export interface DemoPolicy {
  admitAsk(ip: string): DemoAdmission;
  admitAnswer(ip: string): DemoAdmission;
  recordTokens(tokens: number): void;
}

const MINUTE_MS = 60_000;

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function createDemoPolicy(limits: DemoLimits, now: () => number = Date.now): DemoPolicy {
  const askHits = new Map<string, number[]>();
  const answerHits = new Map<string, number[]>();
  let day = utcDay(now());
  let asks = 0;
  let answers = 0;
  let tokens = 0;

  function rollover(): void {
    const today = utcDay(now());
    if (today !== day) {
      day = today;
      asks = 0;
      answers = 0;
      tokens = 0;
      askHits.clear();
      answerHits.clear();
    }
  }

  function admit(
    hits: Map<string, number[]>,
    ip: string,
    perMinute: number,
    used: number,
    maxPerDay: number,
  ): DemoAdmission {
    if (used >= maxPerDay || tokens >= limits.maxTokensPerDay) {
      return { ok: false, reason: "budget_exhausted", retryAfterMs: null };
    }
    const window = (hits.get(ip) ?? []).filter((at) => now() - at < MINUTE_MS);
    if (window.length >= perMinute) {
      const oldest = window[0] ?? now();
      return { ok: false, reason: "rate_limited", retryAfterMs: MINUTE_MS - (now() - oldest) };
    }
    window.push(now());
    hits.set(ip, window);
    return { ok: true };
  }

  return {
    admitAsk(ip: string): DemoAdmission {
      // Rollover first: admit() reads counters evaluated at the call site.
      rollover();
      const verdict = admit(askHits, ip, limits.askPerMinute, asks, limits.maxAsksPerDay);
      // Attempts count even when the model later fails: fail conservative.
      if (verdict.ok) asks += 1;
      return verdict;
    },
    admitAnswer(ip: string): DemoAdmission {
      rollover();
      const verdict = admit(
        answerHits,
        ip,
        limits.answerPerMinute,
        answers,
        limits.maxAnswersPerDay,
      );
      if (verdict.ok) answers += 1;
      return verdict;
    },
    recordTokens(count: number): void {
      rollover();
      if (Number.isFinite(count) && count > 0) tokens += Math.floor(count);
    },
  };
}

/** Uniform body for demo-rejected mutations. */
export function demoReadonly(): { error: { code: string; message: string } } {
  return { error: { code: "readonly_demo", message: "not available in the read-only demo" } };
}

/** Billable tokens behind a model outcome (reasoning rides inside completion). */
export function demoUsageTokens(
  usage: { promptTokens: number; completionTokens: number } | null | undefined,
): number {
  if (!usage) return 0;
  return usage.promptTokens + usage.completionTokens;
}

/** Recorded example questions for the budget-exhausted response (ARCH §18). */
export function recordedExamples(thread: AskThread, cap = 5): string[] {
  const seen = new Set<string>();
  const examples: string[] = [];
  for (const message of thread.messages) {
    if (message.role !== "user") continue;
    const text = message.text.trim();
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    examples.push(text);
    if (examples.length >= cap) break;
  }
  return examples;
}

export interface DemoStaticHit {
  file: string;
  contentType: string;
  immutable: boolean;
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

function staticContentType(file: string): string {
  const dot = file.lastIndexOf(".");
  const ext = dot >= 0 ? file.slice(dot).toLowerCase() : "";
  return STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// Resolves a request path against the baked web dir. Exact files serve;
// extensionless routes fall back to index.html (SPA); missing assets 404.
// Anything escaping the web dir resolves to null: no arbitrary file reads.
export function resolveDemoStatic(webDir: string, requestPath: string): DemoStaticHit | null {
  let pathname = requestPath.split("?")[0] ?? "/";
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const root = normalize(webDir);
  const candidate = normalize(join(root, pathname));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  const serve = (file: string, immutable: boolean): DemoStaticHit | null => {
    if (!existsSync(file)) return null;
    try {
      if (!statSync(file).isFile()) return null;
    } catch {
      return null;
    }
    return { file, contentType: staticContentType(file), immutable };
  };
  const direct = serve(candidate, pathname.startsWith("/assets/"));
  if (direct) return direct;
  const lastSegment = pathname.split("/").pop() ?? "";
  if (lastSegment.includes(".")) return null;
  return serve(join(root, "index.html"), false);
}
