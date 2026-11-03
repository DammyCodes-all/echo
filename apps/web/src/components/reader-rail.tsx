import type { Change, ChangeCodeFile, ChangeFile, ProgressState } from "@echo/contracts";
import { useCallback } from "react";
import type { AskChangeRef } from "./ask-thread-panel";
import { AskThread } from "./ask-thread-panel";

function dotClass(state: ProgressState | undefined, isCurrent: boolean): string {
  const base = "h-2 w-2 shrink-0 rounded-full";
  // The accent marks only where the reader is, mirroring the tape.
  if (isCurrent) return `${base} bg-dusk-accent`;
  if (state === "understood") return `${base} bg-dusk-muted`;
  if (state === "skipped") return `${base} bg-dusk-muted/40`;
  if (state === "viewed") return `${base} bg-dusk-pill`;
  return `${base} bg-dusk-track`;
}

function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "(root)" : path.slice(0, index);
}

function baseOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

function shortDir(dir: string): string {
  const parts = dir.split("/");
  let short = dir;
  // apps/<name>/src/... -> <name>/... : the apps/ + src/ noise costs ~9 chars
  // in a 320px rail and carries no signal.
  if (parts[0] === "apps" && parts.length >= 3 && parts[2] === "src") {
    short = [parts[1], ...parts.slice(3)].join("/") || dir;
  } else if (parts[0] === "apps") {
    short = parts.slice(1).join("/") || dir;
  }
  // Middle-truncate deep dirs: first + … + last keeps both ends visible.
  const segments = short.split("/");
  if (segments.length > 2) return `${segments[0]}/…/${segments[segments.length - 1]}`;
  return short;
}

type GroupedFiles = {
  dir: string;
  count: number;
  added: number;
  removed: number;
  hasStats: boolean;
  entries: Array<{ path: string; note: string; added: number | null; removed: number | null }>;
};

/** Group files by parent dir so a 10-file change reads as 2-3 quiet rows. */
function groupByDir(
  files: ChangeFile[],
  codeFiles: ChangeCodeFile[] | null | undefined,
): GroupedFiles[] {
  const stats = new Map((codeFiles ?? []).map((entry) => [entry.path, entry]));
  const groups = new Map<string, GroupedFiles>();
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) {
    const dir = dirOf(file.path);
    const stat = stats.get(file.path) ?? null;
    let group = groups.get(dir);
    if (group === undefined) {
      group = { dir, count: 0, added: 0, removed: 0, hasStats: false, entries: [] };
      groups.set(dir, group);
    }
    group.count += 1;
    group.entries.push({
      path: file.path,
      note: file.note,
      added: stat?.added ?? null,
      removed: stat?.removed ?? null,
    });
    if (stat !== null) {
      group.hasStats = true;
      group.added += stat.added;
      group.removed += stat.removed;
    }
  }
  return [...groups.values()].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

type ReaderRailProps = {
  changes: Change[];
  currentIndex: number;
  getState: (change: Pick<Change, "id" | "version">) => ProgressState | undefined;
  onJump: (index: number) => void;
  /** Files of the change on screen, with their one-line notes. */
  files: ChangeFile[];
  /** Served diff stats for the change on screen; null while loading. */
  codeFiles?: ChangeCodeFile[] | null;
  /** Companion tab: the action row and wrap-up can flip this to "ask". */
  tab?: "changes" | "ask";
  onTabChange?: (tab: "changes" | "ask") => void;
  /**
   * Ask thread wiring; absent (e.g. the showcase) means no Ask tab and
   * the rail is just the navigator.
   */
  sessionId?: string;
  askChange?: AskChangeRef;
  askScopeAll?: boolean;
  onClearAskScope?: () => void;
};

export function ReaderRail({
  changes,
  currentIndex,
  getState,
  onJump,
  files,
  codeFiles = null,
  tab,
  onTabChange,
  sessionId,
  askChange = null,
  askScopeAll = false,
  onClearAskScope,
}: ReaderRailProps) {
  const activeTab = tab ?? "changes";
  const askEnabled = (sessionId?.length ?? 0) > 0;
  // Group by parent dir: a 10-file change reads as 2-3 quiet rows.
  const groups = groupByDir(files, codeFiles);
  // Long sessions scroll the navigator: keep the current row in view as the
  // reader moves. Nearest-block never moves the page itself.
  const scrollCurrent = useCallback((node: HTMLButtonElement | null) => {
    node?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <aside id="reader-rail" className="space-y-4 scroll-mt-24 lg:sticky lg:top-20 lg:self-start">
      <div
        role="tablist"
        aria-label="Session companion"
        className="flex gap-4 border-b border-dusk-hairline"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "changes"}
          onClick={() => onTabChange?.("changes")}
          className={`-mb-px border-b-2 px-1 pb-2 text-xs uppercase tracking-widest transition-colors ${
            activeTab === "changes"
              ? "border-dusk-accent text-dusk-ink"
              : "border-transparent text-dusk-muted hover:text-dusk-ink"
          }`}
        >
          Changes
        </button>
        {askEnabled ? (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "ask"}
            onClick={() => onTabChange?.("ask")}
            className={`-mb-px border-b-2 px-1 pb-2 text-xs uppercase tracking-widest transition-colors ${
              activeTab === "ask"
                ? "border-dusk-accent text-dusk-ink"
                : "border-transparent text-dusk-muted hover:text-dusk-ink"
            }`}
          >
            Ask
          </button>
        ) : null}
      </div>

      {activeTab === "ask" && askEnabled ? (
        <div
          role="tabpanel"
          aria-label="Ask about this session"
          className="flex min-h-[320px] max-h-[70vh] flex-col lg:max-h-[calc(100vh-14rem)]"
        >
          <AskThread
            sessionId={sessionId ?? ""}
            change={askScopeAll ? null : askChange}
            onClearScope={() => onClearAskScope?.()}
          />
        </div>
      ) : (
        <>
          <nav aria-label="Changes in this session">
            <ol className="space-y-1 lg:max-h-[38vh] lg:overflow-y-auto">
              {changes.map((change, index) => {
                const isCurrent = index === currentIndex;
                return (
                  <li key={`${change.id}@v${change.version}`}>
                    <button
                      type="button"
                      ref={isCurrent ? scrollCurrent : undefined}
                      onClick={() => onJump(index)}
                      aria-current={isCurrent ? "true" : undefined}
                      title={change.title}
                      className={`flex w-full items-center gap-2.5 rounded-dusk-code px-2.5 py-2 text-left text-sm transition-colors ${
                        isCurrent
                          ? "bg-dusk-pill font-medium text-dusk-ink"
                          : "text-dusk-muted hover:bg-dusk-pill/50 hover:text-dusk-ink"
                      }`}
                    >
                      <span aria-hidden className={dotClass(getState(change), isCurrent)} />
                      <span className="w-4 shrink-0 text-right tabular-nums opacity-70">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{change.title}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>

          <div>
            <p className="flex items-baseline justify-between gap-2 text-xs uppercase tracking-widest text-dusk-muted">
              <span>Files it touched</span>
              {codeFiles !== null ? (
                <span className="shrink-0 font-mono normal-case tracking-normal tabular-nums">
                  <span className="text-dusk-pass">
                    +{codeFiles.reduce((sum, file) => sum + file.added, 0)}
                  </span>{" "}
                  <span className="text-dusk-fail">
                    −{codeFiles.reduce((sum, file) => sum + file.removed, 0)}
                  </span>
                </span>
              ) : null}
            </p>
            <div className="mt-1 space-y-0.5">
              {groups.map((group) => {
                // Nested areas read as children: the full dir stays in the
                // tooltip, the row shows only the part below its parent.
                const parent = groups
                  .filter((other) => other !== group && group.dir.startsWith(`${other.dir}/`))
                  .sort((a, b) => b.dir.length - a.dir.length)[0];
                const label =
                  parent === undefined
                    ? shortDir(group.dir)
                    : group.dir.slice(parent.dir.length + 1);
                return (
                  <details
                    key={group.dir}
                    className={`group py-0.5 ${parent === undefined ? "" : "ml-4"}`}
                  >
                    <summary className="flex cursor-pointer list-none items-center gap-2 py-1.5 text-sm [&::-webkit-details-marker]:hidden">
                      <span
                        aria-hidden
                        className="shrink-0 text-xs text-dusk-muted transition-transform group-open:rotate-90"
                      >
                        ›
                      </span>
                      <span
                        title={group.dir}
                        className="min-w-0 flex-1 truncate font-mono text-xs text-dusk-ink"
                      >
                        {label}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-dusk-muted">
                        {group.count} {group.count === 1 ? "file" : "files"}
                      </span>
                    </summary>
                    <ul className="ml-4 space-y-2 py-1 pl-1">
                      {group.entries.map((entry) => (
                        <li key={entry.path} className="min-w-0">
                          <p
                            title={entry.path}
                            className="truncate font-mono text-xs text-dusk-ink"
                          >
                            {baseOf(entry.path)}
                          </p>
                          <p className="mt-0.5 text-xs leading-5 text-dusk-muted">{entry.note}</p>
                        </li>
                      ))}
                    </ul>
                  </details>
                );
              })}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
