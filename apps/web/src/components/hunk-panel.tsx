import type { HunkEvidence, SessionReview, StoredEvent } from "@echo/contracts";
import { getOpenedHunks, markHunkOpened } from "../opened-hunks";

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

function rangesOverlap(aStart: number, aLines: number, bStart: number, bLines: number): boolean {
  const aEnd = aStart + Math.max(aLines, 1) - 1;
  const bEnd = bStart + Math.max(bLines, 1) - 1;
  return Math.max(aStart, bStart) <= Math.min(aEnd, bEnd);
}

function evidenceForHunk(hunk: HunkEntry, review?: SessionReview | null): HunkEvidence[] {
  if (!review) return [];
  const matches = review.hunks.filter(
    (entry) =>
      entry.path === hunk.path &&
      rangesOverlap(entry.newStart, entry.newLines, hunk.additionStart, hunk.additionLines),
  );
  return matches.flatMap((entry) => review.evidenceByHunk[entry.id] ?? []);
}

function riskForHunk(hunk: HunkEntry, review?: SessionReview | null): string | null {
  if (!review) return null;
  const match = review.hunks.find(
    (entry) =>
      entry.path === hunk.path &&
      rangesOverlap(entry.newStart, entry.newLines, hunk.additionStart, hunk.additionLines),
  );
  if (!match || match.riskReasons.length === 0) return null;
  return `risk ${match.riskScore} · ${match.riskReasons.join(", ")}`;
}
export function HunkPanel({
  hunks,
  events,
  selectedPath,
  onSelect,
  sessionId,
  review,
}: {
  hunks: HunkEntry[];
  events: StoredEvent[];
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  sessionId?: string;
  review?: SessionReview | null;
}) {
  const opened = sessionId !== undefined ? new Set(getOpenedHunks(sessionId)) : new Set<string>();
  return (
    <section
      aria-label="Hunk inspector"
      className="overflow-hidden rounded-dusk-card bg-dusk-surface"
    >
      <div className="border-b border-dusk-hairline px-6 py-4">
        <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
          Hunk inspector · {hunks.length} hunk{hunks.length === 1 ? "" : "s"}
        </p>
      </div>
      {hunks.length === 0 ? (
        <p className="p-6 text-sm text-dusk-muted">Hunks appear here once the diff loads.</p>
      ) : (
        <ol className="max-h-96 divide-y divide-dusk-hairline overflow-auto">
          {hunks.map((hunk) => {
            const reviewed = evidenceForHunk(hunk, review);
            const candidates = review ? [] : candidateEvents(hunk.path, events);
            const risk = riskForHunk(hunk, review);
            const active = hunk.path === selectedPath;
            const hunkKey = `${hunk.path}:${hunk.hunkIndex}`;
            const wasOpened = opened.has(hunkKey);
            return (
              <li key={hunkKey}>
                <button
                  type="button"
                  onClick={() => {
                    if (sessionId !== undefined) markHunkOpened(sessionId, hunkKey);
                    onSelect(active ? null : hunk.path);
                  }}
                  className={`block w-full px-6 py-3 text-left text-sm ${
                    active ? "bg-dusk-pill" : "hover:bg-dusk-pill/60"
                  }`}
                >
                  <span className="block truncate font-mono text-[11px] text-dusk-ink">
                    {hunk.path}
                    {wasOpened ? (
                      <span className="ml-2 rounded-dusk-code bg-dusk-track px-1.5 py-0.5 font-mono text-[10px] text-dusk-muted">
                        opened
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block font-mono text-[10px] text-dusk-muted">
                    @@ -{hunk.deletionStart},{hunk.deletionLines} +{hunk.additionStart},
                    {hunk.additionLines} @@ · +{hunk.additionLines} −{hunk.deletionLines}
                  </span>
                  {risk ? (
                    <span className="mt-0.5 block font-mono text-[10px] text-dusk-muted">
                      {risk}
                    </span>
                  ) : null}
                  {reviewed.length > 0 ? (
                    <span className="mt-1 flex flex-col gap-1">
                      {reviewed.map((entry) => (
                        <span
                          key={`${entry.relation}-${entry.confidence}-${entry.snapshotId ?? "none"}-${entry.eventId ?? "none"}-${entry.toolCallId ?? "none"}-${entry.detail}`}
                          title={`${entry.relation} · ${entry.confidence}`}
                          className="block font-mono text-[10px] leading-4 text-dusk-muted"
                        >
                          {entry.relation} · {entry.confidence} · {entry.detail}
                        </span>
                      ))}
                    </span>
                  ) : candidates.length > 0 ? (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {candidates.map((event) => (
                        <span
                          key={event.event_id}
                          title="uncertain: matched by file path only"
                          className="rounded-dusk-code bg-dusk-peach-wash px-1.5 py-0.5 font-mono text-[10px] text-dusk-peach"
                        >
                          {eventLabel(event)} · uncertain
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="mt-1 block font-mono text-[10px] text-dusk-muted">
                      {review
                        ? "no linked evidence in this hunk range"
                        : "no tool event references this path"}
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
