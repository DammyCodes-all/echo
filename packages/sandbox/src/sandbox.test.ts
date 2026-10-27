import { describe, expect, it } from "vitest";
import { runBwrap } from "./bwrap";
import { runContainer } from "./container";
import { detectBackends } from "./detect";
import {
  type BackendInfo,
  normalizeStdout,
  pickBackend,
  type RunRequest,
  type RunResult,
  refreshBackends,
  resolveLimits,
  runSandbox,
} from "./index";
import { runWasm } from "./wasm";

const detected = detectBackends();
const dockerAvailable = detected.some((info) => info.name === "docker" && info.available);
const bwrapAvailable = detected.some((info) => info.name === "bwrap" && info.available);
const wasmAvailable = detected.some((info) => info.name === "wasm" && info.available);

const HELLO = 'console.log("hello-echo");';
const DETERMINISTIC = "console.log(JSON.stringify({ a: [1, 2, 3] }));";
const READONLY = `import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The bundle dir differs per backend (/work for docker, /tmp/work for bwrap),
// so resolve it from the script's own location instead of hardcoding.
const here = dirname(fileURLToPath(import.meta.url));
let blocked = 0;
for (const p of ["/pwned-echo", join(here, "evil.mjs")]) {
  try {
    writeFileSync(p, "x");
  } catch {
    blocked++;
  }
}
if (blocked !== 2) process.exit(3);
console.log("READONLY");`;
const NO_NETWORK = `const outcome = await fetch("http://10.255.255.1/", { signal: AbortSignal.timeout(2000) })
  .then(() => "REACHABLE")
  .catch(() => "BLOCKED");
console.log(outcome);`;
const INFINITE_LOOP = "for (;;) {}";
const BIG_OUTPUT = 'for (let i = 0; i < 20000; i++) console.log("0123456789");';
const EAT_MEMORY = `const keep = [];
// fill() commits every page; without it the kernel hands out untouched zero
// pages and the cgroup never charges them (spike observation).
for (let i = 0; i < 64; i++) keep.push(Buffer.alloc(8 * 1024 * 1024).fill(1));
console.log("SURVIVED");`;
// QuickJS has no Node builtins and no top-level await in sync evalCode, so the
// wasm suite uses its own snippets: no imports, no fetch, no Buffer.
const WASM_ISOLATED = `if (typeof process !== "undefined") throw new Error("process leaked");
if (typeof fetch !== "undefined") throw new Error("fetch leaked");
if (typeof Buffer !== "undefined") throw new Error("Buffer leaked");
if (typeof require !== "undefined") throw new Error("require leaked");
console.log("ISOLATED");`;
const WASM_NO_NETWORK = `console.log(typeof fetch === "undefined" ? "BLOCKED" : "REACHABLE");`;
const WASM_ASYNC = `Promise.resolve(7).then((v) => console.log("then:" + v));`;
// Single large string reliably trips the QuickJS malloc limit; many small
// allocations do not (spike observation: limit is best-effort in this build).
const WASM_EAT_MEMORY = `"x".repeat(8 * 1024 * 1024);`;

function backendSuite(
  label: string,
  run: (request: RunRequest) => Promise<RunResult>,
  opts: { memoryCapped: boolean },
): void {
  describe(label, () => {
    it("runs a snippet and captures stdout", { timeout: 30_000 }, async () => {
      const result = await run({ code: HELLO });
      expect(result.status).toBe("ok");
      expect(result.exitCode).toBe(0);
      expect(normalizeStdout(result.stdout)).toBe("hello-echo\n");
    });

    it("is deterministic across two runs", { timeout: 30_000 }, async () => {
      const first = await run({ code: DETERMINISTIC });
      const second = await run({ code: DETERMINISTIC });
      expect(first.status).toBe("ok");
      expect(normalizeStdout(second.stdout)).toBe(normalizeStdout(first.stdout));
    });

    it("keeps the filesystem read-only", { timeout: 30_000 }, async () => {
      const result = await run({ code: READONLY });
      expect(result.status).toBe("ok");
      expect(normalizeStdout(result.stdout)).toContain("READONLY");
    });

    it("blocks the network", { timeout: 30_000 }, async () => {
      const result = await run({ code: NO_NETWORK });
      expect(result.status).toBe("ok");
      expect(normalizeStdout(result.stdout)).toBe("BLOCKED\n");
    });

    it("kills an infinite loop on timeout", { timeout: 30_000 }, async () => {
      const result = await run({ code: INFINITE_LOOP, limits: { timeoutMs: 1500 } });
      expect(result.status).toBe("timeout");
      expect(result.timedOut).toBe(true);
    });

    it("caps oversized output", { timeout: 30_000 }, async () => {
      const result = await run({ code: BIG_OUTPUT, limits: { maxOutputBytes: 65_536 } });
      expect(result.status).toBe("ok");
      expect(result.truncated).toBe(true);
      expect(result.stdout.length).toBeLessThanOrEqual(65_536);
    });

    if (opts.memoryCapped) {
      it("fails instead of exceeding the memory cap", { timeout: 30_000 }, async () => {
        const result = await run({ code: EAT_MEMORY, limits: { memoryMb: 128 } });
        expect(result.status).toBe("error");
      });
    }
  });
}

describe("sandbox units", () => {
  it("resolves default limits", () => {
    expect(resolveLimits(undefined)).toEqual({
      timeoutMs: 10_000,
      maxOutputBytes: 65_536,
      memoryMb: 128,
    });
    expect(resolveLimits({ timeoutMs: 500 }).timeoutMs).toBe(500);
  });

  it("normalizes stdout line endings", () => {
    expect(normalizeStdout("a\r\nb\n")).toBe("a\nb\n");
  });

  it("picks the strongest available backend", () => {
    const infos = (names: Array<"docker" | "bwrap" | "wasm">): BackendInfo[] =>
      names.map((name) => ({
        name,
        available: true,
        reason: null,
        version: null,
        image: null,
      }));
    expect(pickBackend(infos(["docker", "bwrap", "wasm"]))).toBe("docker");
    expect(pickBackend(infos(["bwrap", "wasm"]))).toBe("bwrap");
    expect(pickBackend(infos(["wasm"]))).toBe("wasm");
    expect(pickBackend([])).toBeNull();
  });

  it("reports every backend with a reason when unavailable", () => {
    const names = detected.map((info) => info.name).sort();
    expect(names).toEqual(["bwrap", "docker", "wasm"]);
    for (const info of detected) {
      if (!info.available) expect(info.reason ?? "").not.toBe("");
    }
  });

  it("wasm is available and runs a snippet", async () => {
    expect(detected.find((info) => info.name === "wasm")?.available).toBe(true);
    const result = await runWasm({ code: HELLO });
    expect(result.status).toBe("ok");
    expect(normalizeStdout(result.stdout)).toBe("hello-echo\n");
  });

  it("memoizes detection until refreshed", () => {
    const first = detectBackends();
    expect(detectBackends()).toBe(first);
    const refreshed = refreshBackends();
    expect(refreshed).not.toBe(first);
    expect(detectBackends()).toBe(refreshed);
  });
});

describe.skipIf(!dockerAvailable)("docker backend", () => {
  backendSuite("docker backend", runContainer, { memoryCapped: true });

  it("uses the ladder first when docker is available", { timeout: 30_000 }, async () => {
    const result = await runSandbox({ code: HELLO });
    expect(result.backend).toBe("docker");
    expect(result.status).toBe("ok");
  });
});

describe.skipIf(!bwrapAvailable)("bwrap backend", () => {
  // Unprivileged bwrap has no memory cap; the memory test would eat host RAM.
  backendSuite("bwrap backend", runBwrap, { memoryCapped: false });
});

describe.skipIf(!wasmAvailable)("wasm backend", () => {
  // QuickJS has no Node APIs, so this suite uses wasm-safe snippets instead
  // of the shared backendSuite (no imports, no fetch, no Buffer, no await).
  it("runs a snippet and captures stdout", { timeout: 30_000 }, async () => {
    const result = await runWasm({ code: HELLO });
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
    expect(normalizeStdout(result.stdout)).toBe("hello-echo\n");
  });

  it("is deterministic across two runs", { timeout: 30_000 }, async () => {
    const first = await runWasm({ code: DETERMINISTIC });
    const second = await runWasm({ code: DETERMINISTIC });
    expect(first.status).toBe("ok");
    expect(normalizeStdout(second.stdout)).toBe(normalizeStdout(first.stdout));
  });

  it("exposes no host APIs", { timeout: 30_000 }, async () => {
    const result = await runWasm({ code: WASM_ISOLATED });
    expect(result.status).toBe("ok");
    expect(normalizeStdout(result.stdout)).toContain("ISOLATED");
  });

  it("has no network", { timeout: 30_000 }, async () => {
    const result = await runWasm({ code: WASM_NO_NETWORK });
    expect(result.status).toBe("ok");
    expect(normalizeStdout(result.stdout)).toBe("BLOCKED\n");
  });

  it("drains async jobs", { timeout: 30_000 }, async () => {
    const result = await runWasm({ code: WASM_ASYNC });
    expect(result.status).toBe("ok");
    expect(normalizeStdout(result.stdout)).toContain("then:7");
  });

  it("kills an infinite loop on timeout", { timeout: 30_000 }, async () => {
    const result = await runWasm({ code: INFINITE_LOOP, limits: { timeoutMs: 1500 } });
    expect(result.status).toBe("timeout");
    expect(result.timedOut).toBe(true);
  });

  it("caps oversized output", { timeout: 30_000 }, async () => {
    const result = await runWasm({ code: BIG_OUTPUT, limits: { maxOutputBytes: 65_536 } });
    expect(result.status).toBe("ok");
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(65_536);
  });

  it("fails instead of exceeding the memory cap", { timeout: 30_000 }, async () => {
    const result = await runWasm({ code: WASM_EAT_MEMORY, limits: { memoryMb: 4 } });
    expect(result.status).toBe("error");
    expect(result.reason ?? "").toContain("memory");
  });
});
