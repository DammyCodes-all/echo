import type { Hunk } from "@pierre/diffs";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useParams } from "react-router";
import { api, summarizePayload } from "../api";
import { DiffPanel } from "../components/diff-panel";
import { FileStatePanel } from "../components/file-state-panel";
import { type HunkEntry, HunkPanel } from "../components/hunk-panel";
import { ScaffoldPage } from "../components/scaffold-page";

function kindClass(kind: string): string {
  if (kind === "turn.failed") return "bg-red-400/10 text-red-300";
  if (kind.startsWith("turn.")) return "bg-violet-400/10 text-violet-300";
  if (kind === "file.snapshot") return "bg-cyan-400/10 text-cyan-300";
  if (kind.startsWith("tool.")) return "bg-amber-400/10 text-amber-300";
  if (kind.startsWith("model.")) return "bg-sky-400/10 text-sky-300";
  if (kind.startsWith("prompt.")) return "bg-zinc-200/10 text-zinc-200";
  if (kind.startsWith("session.")) return "bg-emerald-400/10 text-emerald-300";
  if (kind.startsWith("capture.")) return "bg-red-400/10 text-red-300";
  return "bg-zinc-700/40 text-zinc-300";
}

export function ReplayPage() {
  const { sessionId = "" } = useParams();
  const events = useQuery({
    queryKey: ["events", sessionId],
    queryFn: () => api.events(sessionId),
    refetchInterval: 4000,
  });
  const [hunks, setHunks] = useState<HunkEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const onHunks = useCallback((path: string, fileHunks: Hunk[]) => {
    setHunks((previous) => [
      ...previous.filter((hunk) => hunk.path !== path),
      ...fileHunks.map((hunk, hunkIndex) => ({
        path,
        hunkIndex,
        deletionStart: hunk.deletionStart,
        deletionLines: hunk.deletionLines,
        additionStart: hunk.additionStart,
        additionLines: hunk.additionLines,
      })),
    ]);
  }, []);

  return (
    <ScaffoldPage
      eyebrow="Session replay"
      title="Captured actions"
      description="The raw tape for this session, oldest first, with file state, diff and hunk inspector below."
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/30">
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">Timeline</p>
            <span className="font-mono text-[10px] text-zinc-500">
              {events.data?.length ?? 0} events
            </span>
          </div>
          {events.isPending ? <p className="p-4 text-sm text-zinc-400">Loading tape…</p> : null}
          {events.isError ? (
            <p className="p-4 text-sm text-red-300">Could not load events.</p>
          ) : null}
          {events.data && events.data.length === 0 ? (
            <p className="p-4 text-sm text-zinc-400">No events captured for this session yet.</p>
          ) : null}
          <ol className="max-h-[560px] divide-y divide-zinc-800/70 overflow-auto">
            {events.data?.map((event) => (
              <li
                key={event.record_key ?? event.event_id}
                className="flex items-start gap-3 px-4 py-2.5 text-sm"
              >
                <span className="w-8 shrink-0 pt-0.5 text-right font-mono text-[10px] text-zinc-600">
                  {event.position_seq}
                </span>
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${kindClass(event.kind)}`}
                >
                  {event.kind}
                </span>
                <span className="min-w-0 flex-1 break-words pt-0.5 text-zinc-300">
                  {summarizePayload(event)}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div className="space-y-4">
          <HunkPanel
            hunks={hunks}
            events={events.data ?? []}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
          />
        </div>
      </div>
      <FileStatePanel sessionId={sessionId} />
      <DiffPanel
        sessionId={sessionId}
        selectedPath={selectedPath}
        onSelectPath={setSelectedPath}
        onHunks={onHunks}
      />
    </ScaffoldPage>
  );
}
