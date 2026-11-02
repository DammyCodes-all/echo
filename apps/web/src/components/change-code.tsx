import type { ChangeCodeFile, ChangeCodeResponse } from "@echo/contracts";
import { ArrowRight01Icon, Copy01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { PatchDiff } from "@pierre/diffs/react";
import { useEffect, useMemo, useRef, useState } from "react";

function baseOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

/** Build a minimal unified patch per file so Pierre can highlight + word-diff.
 * The `diff --git` line is required: without it Pierre reads the a/b
 * paths as a rename and renders the rename UI instead of the change. */
function patchForFile(path: string, hunks: ChangeCodeFile["hunks"]): string {
  const header = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  const body = hunks
    .map((hunk) => {
      const head = `@@ -${hunk.prevStart},${hunk.prevLines} +${hunk.nextStart},${hunk.nextLines} @@`;
      const lines = hunk.lines
        .map((line) =>
          line.kind === "add"
            ? `+${line.text}`
            : line.kind === "del"
              ? `-${line.text}`
              : ` ${line.text}`,
        )
        .join("\n");
      return `${head}\n${lines}`;
    })
    .join("\n");
  return `${header}${body}\n`;
}

/** Pierre paints its own dark slab; pull its surfaces onto dusk instead.
 * Only the neutral backgrounds are overridden — addition/deletion washes
 * keep Pierre's signal colors. Injected into the shadow root, where it
 * wins over the theme layer. */
const DUSK_DIFF_SURFACES = `:host {
  --diffs-bg: #1c1c30;
  --diffs-bg-context: #1c1c30;
  --diffs-bg-context-gutter: #1c1c30;
  --diffs-bg-separator: #1c1c30;
  --diffs-bg-buffer: #1c1c30;
}`;

/** Shimmer shown while Pierre parses/highlights after expand: the toggle
 *  mounts the diff on open, so without this the panel sits blank for a beat.
 *  Widths cycle deterministically — no random, no layout hook needed. */
const SKELETON_WIDTHS = [92, 76, 85, 63, 90, 70, 83, 55];

function DiffSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden className="space-y-1.5 px-3 py-3 motion-safe:animate-pulse">
      {Array.from({ length: rows }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are static and never reorder
          key={`diff-skeleton-${index}`}
          className="flex items-center gap-2"
        >
          <div className="h-3.5 w-10 shrink-0 rounded-dusk-code bg-dusk-pill/50" />
          <div
            className="h-3.5 rounded-dusk-code bg-dusk-pill/50"
            style={{ width: `${SKELETON_WIDTHS[index % SKELETON_WIDTHS.length]}%` }}
          />
        </div>
      ))}
    </div>
  );
}

function CodeFile({ file, note }: { file: ChangeCodeFile; note: string | null }) {
  const [copied, setCopied] = useState(false);
  // Pierre measures on mount: while the row is closed the content is
  // display:none, so a hidden mount measures zero height and stays blank.
  // The row owns its open state (no native toggle, no :open selector) so
  // the chevron, the mount, and the disclosure can never disagree.
  const [isOpen, setIsOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  // Pierre's children land in light DOM, so watch for real content: the
  // skeleton only appears if the wait is actually long. Fast diffs paint
  // before the timer fires and never flash a shimmer.
  const [showSkeleton, setShowSkeleton] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    setShowSkeleton(false);
    const panel = panelRef.current;
    const hasContent = () => (panel?.textContent?.trim().length ?? 0) > 0;
    if (hasContent()) return;
    let done = false;
    const observer = new MutationObserver(() => {
      if (hasContent()) {
        done = true;
        observer.disconnect();
        // No-op when the timer never fired; hides the shimmer otherwise.
        setShowSkeleton(false);
      }
    });
    if (panel !== null) {
      observer.observe(panel, { childList: true, subtree: true, characterData: true });
    }
    const timer = window.setTimeout(() => {
      if (!done) setShowSkeleton(true);
    }, 150);
    return () => {
      done = true;
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [isOpen]);
  const toggle = () => {
    setIsOpen((was) => !was);
  };
  // Mount the heavy diff after the open paints: the click commits only the
  // chevron + panel, then parsing/highlighting lands in the next frames
  // behind the skeleton instead of freezing the toggle itself.
  useEffect(() => {
    if (!isOpen || revealed) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setRevealed(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [isOpen, revealed]);
  const copy = () => {
    void navigator.clipboard?.writeText(file.path).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  const stats = (
    <p className="font-mono text-xs tabular-nums">
      <span className="text-dusk-pass">+{file.added}</span>{" "}
      <span className="text-dusk-fail">−{file.removed}</span>
    </p>
  );
  const copyButton = (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        copy();
      }}
      title="Copy file path"
      aria-label={`Copy path ${file.path}`}
      className="inline-flex items-center rounded p-1 text-dusk-muted hover:text-dusk-ink"
    >
      <HugeiconsIcon icon={copied ? Tick01Icon : Copy01Icon} size={14} strokeWidth={1.8} />
      <span className="sr-only">{copied ? "Copied" : "Copy file path"}</span>
    </button>
  );
  const patch = useMemo(
    () => (revealed ? patchForFile(file.path, file.hunks) : null),
    [revealed, file.path, file.hunks],
  );
  if (file.hunks.length === 0) {
    return (
      <div className="overflow-hidden rounded-dusk-code border border-dusk-hairline">
        <div className="bg-dusk-surface px-3 py-2">
          <FileHeader
            file={file}
            note={note}
            trailing={
              <div className="flex shrink-0 items-center gap-2">
                {stats}
                {copyButton}
              </div>
            }
          />
        </div>
        <p className="px-3 py-2 text-sm text-dusk-muted">
          {file.truncated
            ? "The diff for this file is unavailable."
            : "No rendered lines in this file."}
        </p>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-dusk-code border border-dusk-hairline">
      <div className="flex items-center gap-2 bg-dusk-surface px-3 py-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={isOpen}
          aria-label={`${isOpen ? "Hide" : "Show"} diff for ${file.path}`}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <span
            aria-hidden
            className={`flex shrink-0 items-center text-dusk-muted transition-transform ${isOpen ? "rotate-90" : ""}`}
          >
            <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.8} />
          </span>
          <FileHeader
            file={file}
            note={note}
            trailing={<div className="flex shrink-0 items-center gap-2">{stats}</div>}
          />
        </button>
        {copyButton}
      </div>
      {isOpen ? (
        <div ref={panelRef} className="border-t border-dusk-hairline">
          {showSkeleton ? <DiffSkeleton /> : null}
          {patch !== null ? (
            <PatchDiff
              patch={patch}
              disableWorkerPool
              options={{
                diffStyle: "unified",
                lineDiffType: "word",
                hunkSeparators: "simple",
                diffIndicators: "none",
                disableFileHeader: true,
                themeType: "dark",
                overflow: "scroll",
                unsafeCSS: DUSK_DIFF_SURFACES,
              }}
            />
          ) : null}
          {file.truncated ? (
            <p className="px-3 py-2 text-xs text-dusk-muted">
              Showing the first lines only — the counts above cover the whole file.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FileHeader({
  file,
  note,
  trailing,
}: {
  file: ChangeCodeFile;
  note: string | null;
  trailing: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p title={file.path} className="truncate font-mono text-xs text-dusk-ink">
          {baseOf(file.path)}
        </p>
        {note !== null ? <p className="mt-0.5 truncate text-xs text-dusk-muted">{note}</p> : null}
      </div>
      {trailing}
    </div>
  );
}

export function ChangeCode({
  code,
  notes = {},
}: {
  code: ChangeCodeResponse;
  /** Why-line per path, from the story's file list. */
  notes?: Record<string, string>;
}) {
  return (
    <div className="space-y-3">
      {code.files.map((file) => (
        <CodeFile key={file.path} file={file} note={notes[file.path] ?? null} />
      ))}
    </div>
  );
}
