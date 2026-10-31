import type { Change, ChangeCodeFile, ChangeFile, ProgressState } from "@echo/contracts";
import { useCallback } from "react";

function dotClass(state: ProgressState | undefined, isCurrent: boolean): string {
  const base = "mt-1.5 h-2 w-2 shrink-0 rounded-full";
  // The accent marks only where the reader is, mirroring the tape.
  if (isCurrent) return `${base} bg-dusk-accent`;
  if (state === "understood") return `${base} bg-dusk-muted`;
  if (state === "skipped") return `${base} bg-dusk-muted/40`;
  if (state === "viewed") return `${base} bg-dusk-pill`;
  return `${base} bg-dusk-track`;
}

type RelatedChange = { index: number; title: string };

type ReaderRailProps = {
  changes: Change[];
  currentIndex: number;
  getState: (change: Pick<Change, "id" | "version">) => ProgressState | undefined;
  onJump: (index: number) => void;
  /** Files of the change on screen, with their one-line notes. */
  files: ChangeFile[];
  /** Served diff stats for the change on screen; null while loading. */
  codeFiles?: ChangeCodeFile[] | null;
  /** Other changes touching the same files, in session order. */
  related: RelatedChange[];
};

export function ReaderRail({
  changes,
  currentIndex,
  getState,
  onJump,
  files,
  codeFiles = null,
  related,
}: ReaderRailProps) {
  // Long sessions scroll the navigator: keep the current row in view as the
  // reader moves. Nearest-block never moves the page itself.
  const scrollCurrent = useCallback((node: HTMLButtonElement | null) => {
    node?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <aside className="space-y-8 lg:sticky lg:top-20 lg:self-start">
      <nav aria-label="Changes in this session">
        <p className="text-xs uppercase tracking-widest text-dusk-muted">In this session</p>
        <ol className="mt-2 space-y-0.5 lg:max-h-[38vh] lg:overflow-y-auto">
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
                  className={`flex w-full items-start gap-2 rounded-dusk-code px-2 py-1.5 text-left text-sm ${
                    isCurrent
                      ? "bg-dusk-pill text-dusk-ink"
                      : "text-dusk-muted hover:bg-dusk-pill/50 hover:text-dusk-ink"
                  }`}
                >
                  <span aria-hidden className={dotClass(getState(change), isCurrent)} />
                  <span className="shrink-0 tabular-nums">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{change.title}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <div>
        <p className="text-xs uppercase tracking-widest text-dusk-muted">
          Files in this change · {files.length}
          {codeFiles !== null ? (
            <>
              {" · "}
              <span className="text-dusk-pass">
                +{codeFiles.reduce((sum, file) => sum + file.added, 0)}
              </span>{" "}
              <span className="text-dusk-fail">
                −{codeFiles.reduce((sum, file) => sum + file.removed, 0)}
              </span>
            </>
          ) : null}
        </p>
        <ul className="mt-2 space-y-3">
          {files.map((file) => {
            const stats = codeFiles?.find((entry) => entry.path === file.path) ?? null;
            return (
              <li key={file.path} className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <p
                    title={file.path}
                    className="min-w-0 flex-1 truncate font-mono text-xs text-dusk-ink"
                  >
                    {file.path}
                  </p>
                  {stats !== null ? (
                    <p className="shrink-0 font-mono text-xs tabular-nums">
                      <span className="text-dusk-pass">+{stats.added}</span>{" "}
                      <span className="text-dusk-fail">−{stats.removed}</span>
                    </p>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs leading-5 text-dusk-muted">{file.note}</p>
              </li>
            );
          })}
        </ul>
      </div>

      {related.length > 0 ? (
        <nav aria-label="Related changes">
          <p className="text-xs uppercase tracking-widest text-dusk-muted">Also touched</p>
          <ul className="mt-2 space-y-0.5">
            {related.map((item) => (
              <li key={`${item.index}-${item.title}`}>
                <button
                  type="button"
                  onClick={() => onJump(item.index)}
                  title={item.title}
                  className="flex w-full items-baseline gap-2 rounded-dusk-code px-2 py-1.5 text-left text-sm text-dusk-muted hover:bg-dusk-pill/50 hover:text-dusk-ink"
                >
                  <span className="shrink-0 tabular-nums">{item.index + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </aside>
  );
}
