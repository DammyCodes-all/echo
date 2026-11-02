import type { ChangeCodeFile, ChangeCodeResponse } from "@echo/contracts";
import { PatchDiff } from "@pierre/diffs/react";
import { useState } from "react";

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

function CodeFile({ file, note }: { file: ChangeCodeFile; note: string | null }) {
  const [copied, setCopied] = useState(false);
  if (file.hunks.length === 0) {
    return (
      <div className="overflow-hidden rounded-dusk-code border border-dusk-hairline">
        <div className="bg-dusk-surface px-3 py-2">
          <FileHeader
            file={file}
            note={note}
            copied={copied}
            onCopy={() => {
              void navigator.clipboard?.writeText(file.path).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              });
            }}
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
  const patch = patchForFile(file.path, file.hunks);
  return (
    <details className="group overflow-hidden rounded-dusk-code border border-dusk-hairline">
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <div className="flex items-center gap-2 bg-dusk-surface px-3 py-2">
          <span
            aria-hidden
            className="shrink-0 text-xs text-dusk-muted transition-transform group-open:rotate-90"
          >
            ›
          </span>
          <div className="min-w-0 flex-1">
            <FileHeader
              file={file}
              note={note}
              copied={copied}
              onCopy={(event) => {
                event.preventDefault();
                void navigator.clipboard?.writeText(file.path).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1200);
                });
              }}
            />
          </div>
        </div>
      </summary>
      <div className="border-t border-dusk-hairline">
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
        {file.truncated ? (
          <p className="px-3 py-2 text-xs text-dusk-muted">
            Showing the first lines only — the counts above cover the whole file.
          </p>
        ) : null}
      </div>
    </details>
  );
}

function FileHeader({
  file,
  note,
  copied,
  onCopy,
}: {
  file: ChangeCodeFile;
  note: string | null;
  copied: boolean;
  onCopy: (event: React.MouseEvent) => void;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p title={file.path} className="truncate font-mono text-xs text-dusk-ink">
          {baseOf(file.path)}
        </p>
        {note !== null ? <p className="mt-0.5 truncate text-xs text-dusk-muted">{note}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <p className="font-mono text-xs tabular-nums">
          <span className="text-dusk-pass">+{file.added}</span>{" "}
          <span className="text-dusk-fail">−{file.removed}</span>
        </p>
        <button
          type="button"
          onClick={onCopy}
          title="Copy file path"
          aria-label={`Copy path ${file.path}`}
          className="rounded px-1 py-0.5 font-mono text-[11px] text-dusk-muted hover:text-dusk-ink"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
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
