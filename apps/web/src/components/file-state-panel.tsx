import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, formatTime } from "../api";

function shortOid(commitOid: string): string {
  return commitOid.slice(0, 8);
}

export function FileStatePanel({ sessionId }: { sessionId: string }) {
  const [commit, setCommit] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);

  const snapshots = useQuery({
    queryKey: ["snapshots", sessionId],
    queryFn: () => api.snapshots(sessionId),
  });
  const activeCommit = commit ?? snapshots.data?.at(-1)?.commitOid ?? null;

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
    <section aria-label="File state" className="rounded-xl border border-zinc-800 bg-zinc-900/30">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
        <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">File state</p>
        {snapshots.data && snapshots.data.length > 0 ? (
          <select
            aria-label="Snapshot"
            className="max-w-44 truncate rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 font-mono text-[11px] text-zinc-300"
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

      {snapshots.isPending ? <p className="p-4 text-sm text-zinc-400">Loading snapshots…</p> : null}
      {snapshots.isError ? (
        <p className="p-4 text-sm text-red-300">Could not load snapshots.</p>
      ) : null}
      {snapshots.data && snapshots.data.length === 0 ? (
        <p className="p-4 text-sm text-zinc-400">No snapshots captured for this session yet.</p>
      ) : null}

      {activeCommit && files.data ? (
        <div className="grid gap-0 md:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
          <ol className="max-h-72 overflow-auto border-zinc-800 md:border-r">
            {files.data.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  disabled={!file.captured}
                  onClick={() => setPath(file.path)}
                  className={`block w-full truncate px-4 py-1.5 text-left font-mono text-[11px] ${
                    file.path === activePath
                      ? "bg-zinc-800 text-zinc-100"
                      : file.captured
                        ? "text-zinc-300 hover:bg-zinc-800/50"
                        : "cursor-not-allowed text-zinc-600"
                  }`}
                >
                  {file.path}
                  {file.captured ? null : ` (${file.reason ?? "skipped"})`}
                </button>
              </li>
            ))}
          </ol>
          <div className="min-w-0">
            {content.isPending ? <p className="p-4 text-sm text-zinc-400">Loading file…</p> : null}
            {content.isError ? (
              <p className="p-4 text-sm text-red-300">Could not load file content.</p>
            ) : null}
            {content.data ? (
              <div>
                <p className="truncate border-b border-zinc-800 px-4 py-1.5 font-mono text-[10px] text-zinc-500">
                  {content.data.path} · {content.data.size} B
                  {content.data.truncated ? " · truncated preview" : ""}
                </p>
                <pre className="max-h-64 overflow-auto p-4 font-mono text-[11px] leading-5 text-zinc-200">
                  {content.data.content}
                </pre>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {activeCommit && snapshots.data ? (
        <p className="border-t border-zinc-800 px-4 py-2 font-mono text-[10px] text-zinc-600">
          {snapshots.data.find((snapshot) => snapshot.commitOid === activeCommit)?.trigger} ·{" "}
          {formatTime(
            snapshots.data.find((snapshot) => snapshot.commitOid === activeCommit)?.takenAt ?? "",
          )}
        </p>
      ) : null}
    </section>
  );
}
