import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GuardedOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  env?: NodeJS.ProcessEnv;
  /** Runs synchronously after a timeout kill (e.g. container cleanup). */
  onTimeout?: () => void;
}

export interface GuardedResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  spawnError: string | null;
}

/**
 * Runs a child with an output cap and a timeout. Kills the whole process
 * group on timeout so sandboxed grandchildren cannot outlive the run.
 */
export function spawnGuarded(
  cmd: string,
  args: string[],
  options: GuardedOptions,
): Promise<GuardedResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (error) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
        durationMs: Date.now() - started,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= options.maxOutputBytes) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (next.length > options.maxOutputBytes) {
        truncated = true;
        return next.slice(0, options.maxOutputBytes);
      }
      return next;
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr,
        truncated,
        timedOut,
        durationMs: Date.now() - started,
        spawnError: null,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already exited; the close handler below settles the result.
      }
      try {
        options.onTimeout?.();
      } catch {
        // Cleanup is best effort; the timeout verdict stands regardless.
      }
    }, options.timeoutMs);
    timer.unref?.();

    child.on("error", () => {
      finish(null);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
}

export interface StagedBundle {
  dir: string;
  entry: string;
  cleanup: () => void;
}

/** Writes the snippet for read-only mounting. World-readable on purpose: the
 *  sandbox user (65534/nobody) is not the file owner, and snippets reaching
 *  this point are already redacted. */
export function stageBundle(code: string): StagedBundle {
  const dir = mkdtempSync(join(tmpdir(), "echo-sandbox-"));
  chmodSync(dir, 0o755);
  const entry = join(dir, "main.mjs");
  writeFileSync(entry, code, { mode: 0o644 });
  return {
    dir,
    entry,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
