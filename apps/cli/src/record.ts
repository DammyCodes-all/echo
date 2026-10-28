import { spawn } from "node:child_process";

export interface SpawnedChild {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  kill(signal?: string): unknown;
}

export type SpawnFn = (
  bin: string,
  args: string[],
  opts: { cwd: string; stdio: "inherit" },
) => SpawnedChild;

const realSpawn: SpawnFn = (bin, args, opts) => {
  const child = spawn(bin, args, opts);
  return {
    on: (event, listener) => child.on(event, listener),
    kill: (signal) => child.kill(signal as NodeJS.Signals | undefined),
  };
};

export interface RecordSessionInput {
  museBin?: string;
  museArgs?: string[];
  cwd?: string;
  spawnFn?: SpawnFn;
}

export type RecordSessionResult =
  | { ok: true; exitCode: number; signal: string | null }
  | { ok: false; diagnostic: "spawn_failed"; detail: string };

// Thin interactive wrapper: the session runs attached (stdio inherited) so
// hooks fire with the user's real cwd for attribution. Nothing is invented
// about session linkage here — project resolution stays in the hook
// translator. The child's exit code passes through; signal deaths surface
// the signal name with a conventional nonzero code.
export function runRecordSession(input: RecordSessionInput): Promise<RecordSessionResult> {
  const bin = input.museBin ?? "muse";
  const args = input.museArgs ?? [];
  const cwd = input.cwd ?? process.cwd();
  const spawnFn = input.spawnFn ?? realSpawn;
  return new Promise((resolvePromise) => {
    let child: SpawnedChild;
    try {
      child = spawnFn(bin, args, { cwd, stdio: "inherit" });
    } catch (error) {
      resolvePromise({
        ok: false,
        diagnostic: "spawn_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const forward = (signal: string): void => {
      try {
        child.kill(signal);
      } catch {
        // Child already gone; the exit event below settles the result.
      }
    };
    const onSigint = (): void => forward("SIGINT");
    const onSigterm = (): void => forward("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    child.on("error", (error) => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      resolvePromise({
        ok: false,
        diagnostic: "spawn_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("exit", (code, signal) => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      if (typeof code === "number") {
        resolvePromise({ ok: true, exitCode: code, signal: null });
      } else {
        // Killed by signal: conventional 128 + signum is unknowable here
        // without a signal table, so report signal death as 143/130 below.
        const name = typeof signal === "string" ? signal : "unknown";
        resolvePromise({
          ok: true,
          exitCode: name === "SIGINT" ? 130 : 143,
          signal: name,
        });
      }
    });
  });
}
