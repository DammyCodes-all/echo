import type { StoredEvent } from "@echo/contracts";

export interface HunkEntry {
  path: string;
  hunkIndex: number;
  deletionStart: number;
  deletionLines: number;
  additionStart: number;
  additionLines: number;
}

function toolPath(event: StoredEvent): string | null {
  if (!event.kind.startsWith("tool.")) return null;
  if (event.payload === null || typeof event.payload !== "object") return null;
  const input = (event.payload as { input?: unknown }).input;
  if (input === null || typeof input !== "object") return null;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" ? path : null;
}

function pathMatches(hunkPath: string, candidate: string): boolean {
  const hunkSegments = hunkPath.split("/");
  const candidateSegments = candidate.split("/");
  return candidateSegments.slice(-hunkSegments.length).join("/") === hunkPath;
}

export function candidateEvents(hunkPath: string, events: StoredEvent[]): StoredEvent[] {
  return events.filter((event) => {
    const path = toolPath(event);
    return path !== null && pathMatches(hunkPath, path);
  });
}

function eventLabel(event: StoredEvent): string {
  const payload = event.payload as { name?: unknown } | null;
  const name =
    payload !== null && typeof payload === "object" && typeof payload.name === "string"
      ? payload.name
      : event.kind;
  return `${name} #${event.position_seq}`;
}

export function HunkPanel({
  hunks,
  events,
  selectedPath,
  onSelect,
}: {
  hunks: HunkEntry[];
  events: StoredEvent[];
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
}) {
  return (
    <section
      aria-label="Hunk inspector"
      className="rounded-xl border border-zinc-800 bg-zinc-900/30"
    >
      <div className="border-b border-zinc-800 px-4 py-3">
        <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">
          Hunk inspector · {hunks.length} hunk{hunks.length === 1 ? "" : "s"}
        </p>
      </div>
      {hunks.length === 0 ? (
        <p className="p-4 text-sm text-zinc-400">Hunks appear here once the diff loads.</p>
      ) : (
        <ol className="max-h-96 divide-y divide-zinc-800/70 overflow-auto">
          {hunks.map((hunk) => {
            const candidates = candidateEvents(hunk.path, events);
            const active = hunk.path === selectedPath;
            return (
              <li key={`${hunk.path}:${hunk.hunkIndex}`}>
                <button
                  type="button"
                  onClick={() => onSelect(active ? null : hunk.path)}
                  className={`block w-full px-4 py-2.5 text-left text-sm ${
                    active ? "bg-zinc-800" : "hover:bg-zinc-800/50"
                  }`}
                >
                  <span className="block truncate font-mono text-[11px] text-zinc-200">
                    {hunk.path}
                  </span>
                  <span className="mt-0.5 block font-mono text-[10px] text-zinc-500">
                    @@ -{hunk.deletionStart},{hunk.deletionLines} +{hunk.additionStart},
                    {hunk.additionLines} @@ · +{hunk.additionLines} −{hunk.deletionLines}
                  </span>
                  {candidates.length > 0 ? (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {candidates.map((event) => (
                        <span
                          key={event.event_id}
                          title="uncertain: matched by file path only"
                          className="rounded bg-amber-400/10 px-1.5 py-0.5 font-mono text-[10px] text-amber-300"
                        >
                          {eventLabel(event)} · uncertain
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="mt-1 block font-mono text-[10px] text-zinc-600">
                      no tool event references this path
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
