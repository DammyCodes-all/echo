import { readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";

export interface MuseWatcherLogger {
  error: (obj: unknown, message?: string) => void;
}

export interface WatchHandle {
  close: () => void;
}

export type WatchFn = (
  dir: string,
  listener: (event: string, filename: string | null) => void,
) => WatchHandle;

const defaultWatchFn: WatchFn = (dir, listener) => watch(dir, { persistent: false }, listener);

export interface MuseWatcherOptions {
  sessionsDir: string;
  onDirty: () => void;
  log?: MuseWatcherLogger;
  debounceMs?: number;
  watchFn?: WatchFn;
}

// Latency shortcut over the poll loop, not a replacement: any fs event
// schedules one early ingest pass (runOnce self-guards while running), and
// the interval keeps covering missed events. Recursive watching is manual —
// node:fs watch is non-recursive on Linux — so new date/session/child dirs
// are picked up when their parent reports them.
export function createMuseWatcher(options: MuseWatcherOptions): {
  start: () => void;
  stop: () => void;
  watchedCount: () => number;
} {
  const { sessionsDir, onDirty, log } = options;
  const debounceMs = options.debounceMs ?? 500;
  const watchFn = options.watchFn ?? defaultWatchFn;
  const watched = new Map<string, WatchHandle>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function schedule(): void {
    if (stopped) return;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      try {
        onDirty();
      } catch (error) {
        log?.error({ err: String(error) }, "muse watcher ingest failed");
      }
    }, debounceMs);
  }

  function watchDir(dir: string): void {
    if (stopped || watched.has(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    try {
      watched.set(
        dir,
        watchFn(dir, (_event, filename) => {
          // A new subdirectory (date part, session id, child id) needs its
          // own watch before anything inside it can report.
          if (filename) {
            const abs = join(dir, filename);
            try {
              if (statSync(abs).isDirectory()) watchDir(abs);
            } catch {
              // Vanished mid-event; the next poll covers it.
            }
          }
          schedule();
        }),
      );
    } catch (error) {
      log?.error({ err: String(error), dir }, "muse watcher failed");
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry);
      try {
        if (statSync(abs).isDirectory()) watchDir(abs);
      } catch {
        // Vanished mid-walk; the next poll covers it.
      }
    }
  }

  return {
    start: () => {
      stopped = false;
      watchDir(sessionsDir);
    },
    stop: () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      for (const handle of watched.values()) {
        try {
          handle.close();
        } catch {
          // Best effort on shutdown.
        }
      }
      watched.clear();
    },
    watchedCount: () => watched.size,
  };
}
