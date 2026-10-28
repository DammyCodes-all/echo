import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMuseWatcher, type WatchHandle } from "./muse-watch";

const log = { error: () => {} };

function fakeWatch() {
  const listeners = new Map<string, (event: string, filename: string | null) => void>();
  const closed: string[] = [];
  const watchFn = (
    dir: string,
    listener: (event: string, filename: string | null) => void,
  ): WatchHandle => {
    listeners.set(dir, listener);
    return {
      close: () => {
        closed.push(dir);
        listeners.delete(dir);
      },
    };
  };
  return { listeners, closed, watchFn };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createMuseWatcher", () => {
  it("watches every existing nested dir on start", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-watch-"));
    mkdirSync(join(root, "2026", "10", "28", "ses_a"), { recursive: true });
    mkdirSync(join(root, "2026", "10", "28", "ses_a", "subagent", "child-1"), { recursive: true });
    const fake = fakeWatch();
    const watcher = createMuseWatcher({
      sessionsDir: root,
      onDirty: () => {},
      log,
      watchFn: fake.watchFn,
    });
    watcher.start();
    // root + 2026 + 10 + 28 + ses_a + subagent + child-1 = 7 dirs.
    expect(watcher.watchedCount()).toBe(7);
    expect(fake.listeners.has(join(root, "2026", "10", "28", "ses_a"))).toBe(true);
    watcher.stop();
    expect(watcher.watchedCount()).toBe(0);
    expect(fake.closed).toHaveLength(7);
  });

  it("coalesces a burst of events into one ingest pass", () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "echo-watch-burst-"));
    let calls = 0;
    const fake = fakeWatch();
    const watcher = createMuseWatcher({
      sessionsDir: root,
      onDirty: () => {
        calls += 1;
      },
      log,
      debounceMs: 500,
      watchFn: fake.watchFn,
    });
    watcher.start();
    const fire = fake.listeners.get(root);
    expect(fire).toBeDefined();
    fire?.("change", "session.jsonl");
    fire?.("change", "session.jsonl");
    fire?.("change", "session.jsonl");
    expect(calls).toBe(0);
    vi.advanceTimersByTime(500);
    expect(calls).toBe(1);
    fire?.("change", "session.jsonl");
    vi.advanceTimersByTime(500);
    expect(calls).toBe(2);
    watcher.stop();
  });

  it("picks up newly created subdirectories", () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "echo-watch-new-"));
    let calls = 0;
    const fake = fakeWatch();
    const watcher = createMuseWatcher({
      sessionsDir: root,
      onDirty: () => {
        calls += 1;
      },
      log,
      debounceMs: 100,
      watchFn: fake.watchFn,
    });
    watcher.start();
    expect(watcher.watchedCount()).toBe(1);
    mkdirSync(join(root, "2026", "10", "28", "ses_new"), { recursive: true });
    writeFileSync(join(root, "2026", "10", "28", "ses_new", "session.jsonl"), "{}\n");
    fake.listeners.get(root)?.("rename", "2026");
    expect(watcher.watchedCount()).toBeGreaterThan(1);
    expect(fake.listeners.has(join(root, "2026", "10", "28", "ses_new"))).toBe(true);
    vi.advanceTimersByTime(100);
    expect(calls).toBe(1);
    watcher.stop();
  });

  it("stays silent after stop", () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "echo-watch-stop-"));
    let calls = 0;
    const fake = fakeWatch();
    const watcher = createMuseWatcher({
      sessionsDir: root,
      onDirty: () => {
        calls += 1;
      },
      log,
      debounceMs: 100,
      watchFn: fake.watchFn,
    });
    watcher.start();
    watcher.stop();
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(0);
  });
});
