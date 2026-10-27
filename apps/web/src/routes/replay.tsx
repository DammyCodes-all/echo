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
  if (kind === "turn.failed") return "bg-dusk-fail-wash text-dusk-fail";
  if (kind.startsWith("turn.")) return "bg-dusk-accent-wash text-dusk-accent-soft";
  if (kind === "file.snapshot") return "bg-dusk-pill text-dusk-accent-soft";
  if (kind.startsWith("tool.")) return "bg-dusk-peach-wash text-dusk-peach";
  if (kind.startsWith("model.")) return "bg-dusk-track text-dusk-muted";
  if (kind.startsWith("prompt.")) return "bg-dusk-ink/10 text-dusk-ink";
  if (kind.startsWith("session.")) return "bg-dusk-secondary text-dusk-accent-soft";
  if (kind.startsWith("capture.")) return "bg-dusk-fail-wash text-dusk-fail";
  return "bg-dusk-track text-dusk-muted";
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
        <div className="rounded-dusk-card bg-dusk-surface">
          <div className="flex items-center justify-between border-b border-dusk-hairline px-6 py-4">
            <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">Timeline</p>
            <span className="font-mono text-[10px] text-dusk-muted">
              {events.data?.length ?? 0} events
            </span>
          </div>
          {events.isPending ? <p className="p-6 text-sm text-dusk-muted">Loading tape…</p> : null}
          {events.isError ? (
            <p className="p-6 text-sm text-dusk-fail">Could not load events.</p>
          ) : null}
          {events.data && events.data.length === 0 ? (
            <p className="p-6 text-sm text-dusk-muted">No events captured for this session yet.</p>
          ) : null}
          <ol className="max-h-[560px] divide-y divide-dusk-hairline overflow-auto">
            {events.data?.map((event) => (
              <li
                key={event.record_key ?? event.event_id}
                className="flex items-start gap-3 px-6 py-3 text-sm"
              >
                <span className="w-8 shrink-0 pt-0.5 text-right font-mono text-[10px] text-dusk-muted">
                  {event.position_seq}
                </span>
                <span
                  className={`shrink-0 rounded-dusk-code px-1.5 py-0.5 font-mono text-[10px] ${kindClass(event.kind)}`}
                >
                  {event.kind}
                </span>
                <span className="min-w-0 flex-1 break-words pt-0.5 text-dusk-ink">
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
