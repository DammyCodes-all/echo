import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule } from "quickjs-emscripten";
import { getQuickJS } from "quickjs-emscripten";
import { type BackendInfo, type RunRequest, type RunResult, resolveLimits } from "./types";

export const WASM_ENGINE_HINT =
  "install a QuickJS WASM engine (e.g. quickjs-emscripten), then wire runWasm in packages/sandbox/src/wasm.ts";

let modulePromise: Promise<QuickJSWASMModule> | null = null;

function loadModule(): Promise<QuickJSWASMModule> {
  if (modulePromise === null) modulePromise = getQuickJS();
  return modulePromise;
}

export function probeWasm(): BackendInfo {
  // Presence is proven by the static import above: if the engine were missing
  // or unloadable, this module would fail to load. No host APIs are exposed,
  // so availability here means isolated, not privileged.
  return { name: "wasm", available: true, reason: null, version: null, image: null };
}

/** Best-effort message extraction. Disposes the message handle it creates. */
function readErrorMessage(context: QuickJSContext, error: QuickJSHandle): string {
  try {
    const messageHandle = context.getProp(error, "message");
    try {
      try {
        const text = context.getString(messageHandle);
        if (typeof text === "string" && text.length > 0) return text;
      } catch {
        // Message is not a string; fall through to dump.
      }
      try {
        const dumped = context.dump(messageHandle);
        if (typeof dumped === "string" && dumped.length > 0) return dumped;
      } catch {
        // Dump failed; fall through to the whole-error dump below.
      }
    } finally {
      messageHandle.dispose();
    }
  } catch {
    // The error has no readable message prop (e.g. a thrown primitive).
  }
  try {
    const dumped = context.dump(error);
    if (typeof dumped === "string" && dumped.length > 0) return dumped;
    if (typeof dumped === "number" || typeof dumped === "boolean") return String(dumped);
    if (dumped !== null && dumped !== undefined) {
      try {
        const json = JSON.stringify(dumped);
        if (typeof json === "string" && json.length > 0 && json !== "{}") return json;
      } catch {
        // Not JSON-serializable; fall through to the generic label.
      }
    }
  } catch {
    // Dump itself failed; report generically.
  }
  return "quickjs error";
}

function formatArg(context: QuickJSContext, arg: QuickJSHandle): string {
  const dumped: unknown = context.dump(arg);
  if (typeof dumped === "string") return dumped;
  if (typeof dumped === "undefined") return "undefined";
  try {
    const json = JSON.stringify(dumped);
    if (typeof json === "string") return json;
  } catch {
    // Fall through to String() below.
  }
  return String(dumped);
}

export async function runWasm(request: RunRequest): Promise<RunResult> {
  const started = Date.now();
  const limits = resolveLimits(request.limits);
  const deadline = started + limits.timeoutMs;
  let stdout = "";
  let stderr = "";
  let truncated = false;
  const append = (current: string, text: string): string => {
    if (current.length >= limits.maxOutputBytes) {
      truncated = true;
      return current;
    }
    const next = current + text;
    if (next.length > limits.maxOutputBytes) {
      truncated = true;
      return next.slice(0, limits.maxOutputBytes);
    }
    return next;
  };

  let module_: QuickJSWASMModule;
  try {
    module_ = await loadModule();
  } catch (error) {
    return {
      backend: "wasm",
      image: null,
      status: "unavailable",
      exitCode: null,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
      durationMs: Date.now() - started,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const runtime = module_.newRuntime();
  // Handles owned by us that must be disposed before the context goes away.
  const owned: QuickJSHandle[] = [];
  try {
    runtime.setMemoryLimit(limits.memoryMb * 1024 * 1024);
    runtime.setInterruptHandler(() => Date.now() > deadline);
    const context = runtime.newContext();
    try {
      const logHandle = context.newFunction("log", (...args: QuickJSHandle[]) => {
        const text = args.map((arg) => formatArg(context, arg)).join(" ");
        stdout = append(stdout, `${text}\n`);
      });
      owned.push(logHandle);
      const errorHandle = context.newFunction("error", (...args: QuickJSHandle[]) => {
        const text = args.map((arg) => formatArg(context, arg)).join(" ");
        stderr = append(stderr, `${text}\n`);
      });
      owned.push(errorHandle);
      const consoleHandle = context.newObject();
      owned.push(consoleHandle);
      context.setProp(consoleHandle, "log", logHandle);
      context.setProp(consoleHandle, "error", errorHandle);
      context.setProp(context.global, "console", consoleHandle);

      const evaluated = context.evalCode(request.code, "main.mjs");
      const evalError = evaluated.error;
      if (evalError !== undefined) {
        const timedOut = Date.now() >= deadline;
        let reason: string;
        try {
          reason = timedOut
            ? `exceeded ${limits.timeoutMs} ms; execution interrupted`
            : readErrorMessage(context, evalError);
        } finally {
          evalError.dispose();
        }
        return {
          backend: "wasm",
          image: null,
          status: timedOut ? "timeout" : "error",
          exitCode: null,
          stdout,
          stderr,
          truncated,
          timedOut,
          durationMs: Date.now() - started,
          reason,
        };
      }

      try {
        // Drain async jobs until quiescent: keep executing while jobs run or
        // the completion promise is still pending. The interrupt handler
        // covers synchronous spins; the wall-clock deadline covers hangs
        // the handler cannot reach (e.g. never-settling promises).
        for (let i = 0; i < 10_000; i++) {
          if (Date.now() >= deadline) {
            return {
              backend: "wasm",
              image: null,
              status: "timeout",
              exitCode: null,
              stdout,
              stderr,
              truncated,
              timedOut: true,
              durationMs: Date.now() - started,
              reason: `exceeded ${limits.timeoutMs} ms; async work did not settle`,
            };
          }
          const jobs = runtime.executePendingJobs();
          const jobsError = jobs.error;
          if (jobsError !== undefined) {
            const timedOut = Date.now() >= deadline;
            let reason: string;
            try {
              reason = timedOut
                ? `exceeded ${limits.timeoutMs} ms; async work did not settle`
                : readErrorMessage(context, jobsError);
            } finally {
              jobsError.dispose();
            }
            return {
              backend: "wasm",
              image: null,
              status: timedOut ? "timeout" : "error",
              exitCode: null,
              stdout,
              stderr,
              truncated,
              timedOut,
              durationMs: Date.now() - started,
              reason,
            };
          }
          const executed = jobs.value;
          jobs.dispose();
          const state = context.getPromiseState(evaluated.value);
          if (state.type === "pending") continue;
          if (state.type === "rejected") {
            const timedOut = Date.now() >= deadline;
            let reason: string;
            try {
              reason = timedOut
                ? `exceeded ${limits.timeoutMs} ms; async work did not settle`
                : readErrorMessage(context, state.error);
            } finally {
              state.error.dispose();
            }
            return {
              backend: "wasm",
              image: null,
              status: timedOut ? "timeout" : "error",
              exitCode: null,
              stdout,
              stderr,
              truncated,
              timedOut,
              durationMs: Date.now() - started,
              reason,
            };
          }
          // Fulfilled. A borrowed value (notAPromise) needs no disposal; a
          // promise resolution value is a fresh handle we must free.
          if (!state.notAPromise) state.value.dispose();
          if (executed === 0) {
            return {
              backend: "wasm",
              image: null,
              status: "ok",
              exitCode: 0,
              stdout,
              stderr,
              truncated,
              timedOut: false,
              durationMs: Date.now() - started,
              reason: null,
            };
          }
          // Jobs ran and may have queued more; loop to drain the chain.
        }
        return {
          backend: "wasm",
          image: null,
          status: "timeout",
          exitCode: null,
          stdout,
          stderr,
          truncated,
          timedOut: true,
          durationMs: Date.now() - started,
          reason: `exceeded ${limits.timeoutMs} ms; async work did not settle`,
        };
      } finally {
        evaluated.value.dispose();
      }
    } finally {
      for (let i = owned.length - 1; i >= 0; i--) {
        try {
          const handle = owned[i];
          if (handle?.alive !== false) handle?.dispose();
        } catch {
          // Disposal is cleanup; a dead handle is already free.
        }
      }
      context.dispose();
    }
  } finally {
    try {
      runtime.dispose();
    } catch {
      // Runtime teardown failure after a run carries no evidence value.
    }
  }
}
