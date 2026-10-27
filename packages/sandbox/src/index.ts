import { runBwrap } from "./bwrap";
import { runContainer } from "./container";
import { detectBackends } from "./detect";
import {
  type BackendInfo,
  type BackendName,
  normalizeStdout,
  type RunRequest,
  type RunResult,
  resolveLimits,
} from "./types";
import { runWasm } from "./wasm";

export { runBwrap } from "./bwrap";
export { CONTAINER_IMAGE, runContainer } from "./container";
export { detectBackends, refreshBackends } from "./detect";
export { runWasm, WASM_ENGINE_HINT } from "./wasm";
export type { BackendInfo, BackendName, RunRequest, RunResult };
export { normalizeStdout, resolveLimits };

/** Strong backends in ladder order. wasm runs locally now that its engine is installed. */
export function pickBackend(backends: BackendInfo[]): BackendName | null {
  for (const name of ["docker", "bwrap", "wasm"] as const) {
    if (backends.some((info) => info.name === name && info.available)) return name;
  }
  return null;
}

/**
 * Runs the snippet on the strongest available backend. When none is strong,
 * returns unavailable instead of grading in-process (ADR 0008).
 */
export async function runSandbox(request: RunRequest): Promise<RunResult> {
  const backend = pickBackend(detectBackends());
  if (backend === "docker") return runContainer(request);
  if (backend === "bwrap") return runBwrap(request);
  if (backend === "wasm") return runWasm(request);
  return {
    backend: "wasm",
    image: null,
    status: "unavailable",
    exitCode: null,
    stdout: "",
    stderr: "",
    truncated: false,
    timedOut: false,
    durationMs: 0,
    reason: "no strong backend available; checks are disabled, never graded in-process",
  };
}

/** Structured backend report for `echo-cli doctor`. */
export function describeBackends(): BackendInfo[] {
  return detectBackends();
}
