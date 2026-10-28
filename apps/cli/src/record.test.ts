import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { runRecordSession, type SpawnedChild, type SpawnFn } from "./record";

interface Captured {
  bin: string;
  args: string[];
  cwd: string;
  killed: string[];
  emitter: EventEmitter;
}

function fakeSpawn(captured: Captured): SpawnFn {
  return (bin: string, args: string[], opts: { cwd: string; stdio: "inherit" }) => {
    captured.bin = bin;
    captured.args = args;
    captured.cwd = opts.cwd;
    expect(opts.stdio).toBe("inherit");
    const emitter = captured.emitter;
    const child: SpawnedChild = {
      on: (event: string, listener: (...eventArgs: unknown[]) => void): unknown =>
        emitter.on(event, listener),
      kill: (signal?: string): unknown => {
        captured.killed.push(signal ?? "SIGTERM");
        return true;
      },
    };
    return child;
  };
}

function fresh(): Captured {
  return { bin: "", args: [], cwd: "", killed: [], emitter: new EventEmitter() };
}

describe("runRecordSession", () => {
  it("passes the bin, args and cwd through with inherited stdio", async () => {
    const captured = fresh();
    const pending = runRecordSession({
      museBin: "/stub/muse",
      museArgs: ["--model", "x", "prompt here"],
      cwd: "/repo",
      spawnFn: fakeSpawn(captured),
    });
    captured.emitter.emit("exit", 0, null);
    const result = await pending;
    expect(captured.bin).toBe("/stub/muse");
    expect(captured.args).toEqual(["--model", "x", "prompt here"]);
    expect(captured.cwd).toBe("/repo");
    expect(result).toEqual({ ok: true, exitCode: 0, signal: null });
  });

  it("propagates nonzero exit codes", async () => {
    const captured = fresh();
    const pending = runRecordSession({ museArgs: [], spawnFn: fakeSpawn(captured) });
    expect(captured.bin).toBe("muse");
    captured.emitter.emit("exit", 3, null);
    expect(await pending).toEqual({ ok: true, exitCode: 3, signal: null });
  });

  it("reports signal death with a conventional code", async () => {
    const captured = fresh();
    const pending = runRecordSession({ museArgs: [], spawnFn: fakeSpawn(captured) });
    captured.emitter.emit("exit", null, "SIGTERM");
    expect(await pending).toEqual({ ok: true, exitCode: 143, signal: "SIGTERM" });
  });

  it("reports spawn failures without throwing", async () => {
    const captured = fresh();
    const pending = runRecordSession({
      museBin: "/nonexistent/muse",
      spawnFn: fakeSpawn(captured),
    });
    captured.emitter.emit("error", new Error("spawn ENOENT"));
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic).toBe("spawn_failed");
      expect(result.detail).toContain("ENOENT");
    }
  });
});
