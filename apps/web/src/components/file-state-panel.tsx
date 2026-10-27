import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, formatTime } from "../api";

function shortOid(commitOid: string): string {
  return commitOid.slice(0, 8);
}

export function FileStatePanel({
  sessionId,
  asOfTs = null,
}: {
  sessionId: string;
  /** Scrub position: show the latest snapshot at or before this time. */
  asOfTs?: string | null;
}) {
  const [commit, setCommit] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);

  const snapshots = useQuery({
    queryKey: ["snapshots", sessionId],
    queryFn: () => api.snapshots(sessionId),
  });
  // Manual selection wins; otherwise the scrub position resolves to the
  // nearest snapshot at or before it, else the latest snapshot.
  const scrubbedCommit =
    asOfTs !== null
      ? ([...(snapshots.data ?? [])].filter((snapshot) => snapshot.takenAt <= asOfTs).at(-1)
          ?.commitOid ?? null)
      : null;
  const activeCommit = commit ?? scrubbedCommit ?? snapshots.data?.at(-1)?.commitOid ?? null;

  const files = useQuery({
    queryKey: ["snapshot-files", sessionId, activeCommit],
    queryFn: () => api.snapshotFiles(sessionId, activeCommit as string),
    enabled: activeCommit !== null,
  });
  const captured = files.data?.filter((file) => file.captured) ?? [];
  const activePath = path ?? captured[0]?.path ?? null;

  const content = useQuery({
    queryKey: ["snapshot-blob", sessionId, activeCommit, activePath],
    queryFn: () => api.fileContent(sessionId, activeCommit as string, activePath as string),
    enabled: activeCommit !== null && activePath !== null,
  });

  return (
    <section aria-label="File state" className="rounded-dusk-card bg-dusk-surface">
      <div className="flex items-center justify-between gap-2 border-b border-dusk-hairline px-6 py-4">
        <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">File state</p>
        {snapshots.data && snapshots.data.length > 0 ? (
          <select
            aria-label="Snapshot"
            className="max-w-44 truncate rounded-dusk-code border border-dusk-hairline-strong bg-dusk-surface px-1 py-0.5 font-mono text-[11px] text-dusk-ink"
            value={activeCommit ?? ""}
            onChange={(event) => {
              setCommit(event.target.value);
              setPath(null);
            }}
          >
            {snapshots.data.map((snapshot) => (
              <option key={snapshot.commitOid} value={snapshot.commitOid}>
                {snapshot.trigger} · {shortOid(snapshot.commitOid)}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {snapshots.isPending ? (
        <p className="p-6 text-sm text-dusk-muted">Loading snapshots…</p>
      ) : null}
      {snapshots.isError ? (
        <p className="p-6 text-sm text-dusk-fail">Could not load snapshots.</p>
      ) : null}
      {snapshots.data && snapshots.data.length === 0 ? (
        <p className="p-6 text-sm text-dusk-muted">No snapshots captured for this session yet.</p>
      ) : null}

      {activeCommit && files.data ? (
        <div className="grid gap-0 md:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
          <ol className="max-h-72 overflow-auto border-dusk-hairline md:border-r">
            {files.data.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  disabled={!file.captured}
                  onClick={() => setPath(file.path)}
                  className={`block w-full truncate px-6 py-2 text-left font-mono text-[11px] ${
                    file.path === activePath
                      ? "bg-dusk-pill text-dusk-ink"
                      : file.captured
                        ? "text-dusk-muted hover:bg-dusk-pill/60 hover:text-dusk-ink"
                        : "cursor-not-allowed text-dusk-muted/60"
                  }`}
                >
                  {file.path}
                  {file.captured ? null : ` (${file.reason ?? "skipped"})`}
                </button>
              </li>
            ))}
          </ol>
          <div className="min-w-0">
            {content.isPending ? (
              <p className="p-6 text-sm text-dusk-muted">Loading file…</p>
            ) : null}
            {content.isError ? (
              <p className="p-6 text-sm text-dusk-fail">Could not load file content.</p>
            ) : null}
            {content.data ? (
              <div>
                <p className="truncate border-b border-dusk-hairline px-6 py-2 font-mono text-[10px] text-dusk-muted">
                  {content.data.path} · {content.data.size} B
                  {content.data.truncated ? " · truncated preview" : ""}
                </p>
                <pre className="max-h-64 overflow-auto p-6 font-mono text-[11px] leading-5 text-dusk-ink">
                  {content.data.content}
                </pre>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {activeCommit && snapshots.data ? (
        <p className="border-t border-dusk-hairline px-6 py-2 font-mono text-[10px] text-dusk-muted">
          {snapshots.data.find((snapshot) => snapshot.commitOid === activeCommit)?.trigger} ·{" "}
          {formatTime(
            snapshots.data.find((snapshot) => snapshot.commitOid === activeCommit)?.takenAt ?? "",
          )}
        </p>
      ) : null}
    </section>
  );
}
