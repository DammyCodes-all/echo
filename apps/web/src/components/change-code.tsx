import type { ChangeCodeFile, ChangeCodeResponse } from "@echo/contracts";

function lineClass(kind: "context" | "add" | "del"): string {
  if (kind === "add") return "bg-dusk-pass-wash";
  if (kind === "del") return "bg-dusk-fail-wash";
  return "";
}

function gutterText(value: number | null): string {
  return value === null ? "" : String(value);
}

function CodeFile({ file }: { file: ChangeCodeFile }) {
  return (
    <div className="overflow-hidden rounded-dusk-code border border-dusk-hairline">
      <div className="flex items-baseline justify-between gap-3 bg-dusk-surface px-3 py-2">
        <p title={file.path} className="min-w-0 flex-1 truncate font-mono text-xs text-dusk-ink">
          {file.path}
        </p>
        <p className="shrink-0 font-mono text-xs tabular-nums">
          <span className="text-dusk-pass">+{file.added}</span>{" "}
          <span className="text-dusk-fail">−{file.removed}</span>
        </p>
      </div>
      {file.hunks.length === 0 ? (
        <p className="px-3 py-2 text-sm text-dusk-muted">
          {file.truncated
            ? "The diff for this file is unavailable."
            : "No rendered lines in this file."}
        </p>
      ) : (
        <div className="overflow-x-auto py-1">
          {file.hunks.map((hunk) => (
            <div key={`${hunk.prevStart}-${hunk.nextStart}`} className="mt-1 first:mt-0">
              <p className="px-3 py-1 font-mono text-[11px] text-dusk-muted">
                @@ −{hunk.prevStart},{hunk.prevLines} +{hunk.nextStart},{hunk.nextLines} @@
              </p>
              {hunk.lines.map((line) => (
                <div
                  // Line numbers are unique within a hunk: exactly one side
                  // is set on adds/deletes, both on context lines.
                  key={`${line.kind}-${line.prevNo ?? "x"}-${line.nextNo ?? "x"}`}
                  className={`grid grid-cols-[2.5rem_2.5rem_minmax(0,1fr)] font-mono text-xs leading-5 ${lineClass(line.kind)}`}
                >
                  <span className="select-none pr-2 text-right tabular-nums text-dusk-muted/60">
                    {gutterText(line.prevNo)}
                  </span>
                  <span className="select-none pr-2 text-right tabular-nums text-dusk-muted/60">
                    {gutterText(line.nextNo)}
                  </span>
                  <span className="whitespace-pre pr-3 text-dusk-ink">{line.text}</span>
                </div>
              ))}
            </div>
          ))}
          {file.truncated ? (
            <p className="px-3 py-2 text-xs text-dusk-muted">
              Showing the first lines only — the counts above cover the whole file.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function ChangeCode({ code }: { code: ChangeCodeResponse }) {
  return (
    <div className="space-y-3">
      {code.files.map((file) => (
        <CodeFile key={file.path} file={file} />
      ))}
    </div>
  );
}
