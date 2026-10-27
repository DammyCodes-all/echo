import type { CaptureQuality, TapeEvent } from "@echo/contracts";
import { parseExportDocument, reconcileExport } from "./export";
import { mapMuseToTape } from "./map";
import { detectSequenceGaps, parseMuseContent } from "./reader";

export interface FinalizeInput {
  sessionId: string;
  projectId: string;
  build: string | null;
  liveContent: string;
  childContents?: string[];
  exportDoc?: unknown;
  observedAt?: Date;
}

export interface FinalizeResult {
  events: TapeEvent[];
  quality: CaptureQuality;
  diagnostics: string[];
}

// Pure composition of reader + map + export reconciliation.
// Daemon-side finalization calls this, then owns persistence (tape, shadow
// Git, SQLite). Export-only records are preserved as agent.unknown with
// origin export; precise kinds are never inferred from the export frame.
export function finalizeMuseSession(input: FinalizeInput): FinalizeResult {
  const observedAt = input.observedAt ?? new Date();
  const live = parseMuseContent(input.liveContent);
  const childEvents = (input.childContents ?? []).flatMap(
    (content) => parseMuseContent(content).events,
  );
  const diagnostics: string[] = [];
  if (live.truncatedTail) diagnostics.push("truncated_tail");

  const sequencesByStream = new Map<string, number[]>();
  for (const event of [...live.events, ...childEvents]) {
    const list = sequencesByStream.get(event.stream.id) ?? [];
    list.push(event.sequence);
    sequencesByStream.set(event.stream.id, list);
  }
  let gapCount = 0;
  for (const sequences of sequencesByStream.values()) {
    gapCount += detectSequenceGaps(sequences, live.markers.length).length;
  }
  if (gapCount > 0) diagnostics.push("sequence_jump");

  const mapped = mapMuseToTape([...live.events, ...childEvents], live.markers, live.invalidLines, {
    sessionId: input.sessionId,
    projectId: input.projectId,
    build: input.build,
    observedAt,
  });
  const events = [...mapped.events];
  let quality = mapped.quality;

  if (input.exportDoc !== undefined) {
    const parsed = parseExportDocument(input.exportDoc);
    diagnostics.push(...parsed.diagnostics);
    const liveHashes = new Map<string, string>();
    for (const record of [...live.events, ...childEvents]) {
      liveHashes.set(`${record.stream.id}:${record.sequence}`, record.id);
    }
    const reconciled = reconcileExport(liveHashes, parsed.records);
    diagnostics.push(
      `export_reconciled:added=${reconciled.addedKeys.length}:merged=${reconciled.mergedKeys.length}:conflicts=${reconciled.conflicts.length}`,
    );
    if (reconciled.addedKeys.length > 0 || reconciled.conflicts.length > 0) {
      quality = "partial";
    }
  }

  if (diagnostics.length > 0 && quality === "full") quality = "partial";
  return { events, quality, diagnostics };
}
