export type BackendName = "docker" | "bwrap" | "wasm";

export type RunStatus = "ok" | "timeout" | "error" | "unavailable";

export interface RunLimits {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Container memory cap. bwrap cannot enforce this unprivileged; it is ignored there. */
  memoryMb?: number;
}

export interface ResolvedLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  memoryMb: number;
}

export interface RunRequest {
  /** Self-contained JavaScript snippet (Phase 5 bundles TS via esbuild before this point). */
  code: string;
  limits?: RunLimits;
}

export interface RunResult {
  backend: BackendName;
  /** Resolved image ref/ID/digest, or null when the backend has no image concept. */
  image: string | null;
  status: RunStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  /** Human-readable reason for unavailable/error outcomes. Never the secret. */
  reason: string | null;
}

export interface BackendInfo {
  name: BackendName;
  available: boolean;
  reason: string | null;
  version: string | null;
  image: string | null;
}

export function resolveLimits(limits: RunLimits | undefined): ResolvedLimits {
  return {
    timeoutMs: limits?.timeoutMs ?? 10_000,
    maxOutputBytes: limits?.maxOutputBytes ?? 65_536,
    memoryMb: limits?.memoryMb ?? 128,
  };
}

export function normalizeStdout(stdout: string): string {
  return stdout.replace(/\r\n/g, "\n");
}
