import type { CaptureQuality, TapeEvent } from "@echo/contracts";
import { parseExportDocument, reconcileExport } from "./export";
import { buildTapeEvent, emptyLinks, mapMuseToTape } from "./map";
import type { ParsedMuseMarker } from "./reader";
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
  reconciled: { added: number; merged: number; schemaVersion: number | null } | null;
}

// Pure composition of reader + map + export reconciliation.
// Daemon-side finalization calls this, then owns persistence (tape, shadow
// Git, SQLite). Export-only records are preserved as agent.unknown with
// origin export; precise kinds are never inferred from the export frame.
export function finalizeMuseSession(input: FinalizeInput): FinalizeResult {
  const observedIso = (input.observedAt ?? new Date()).toISOString();
  const live = parseMuseContent(input.liveContent);
  const childParses = (input.childContents ?? []).map((content) => parseMuseContent(content));
  const childEvents = childParses.flatMap((parsed) => parsed.events);
  const allMarkers = [...live.markers, ...childParses.flatMap((parsed) => parsed.markers)];
  const invalidLines =
    live.invalidLines + childParses.reduce((total, parsed) => total + parsed.invalidLines, 0);
  const diagnostics: string[] = [];
  if (live.truncatedTail || childParses.some((parsed) => parsed.truncatedTail)) {
    diagnostics.push("truncated_tail");
  }

  const sequencesByStream = new Map<string, number[]>();
  for (const event of [...live.events, ...childEvents]) {
    const list = sequencesByStream.get(event.stream.id) ?? [];
    list.push(event.sequence);
    sequencesByStream.set(event.stream.id, list);
  }
  const markersByStream = new Map<string, ParsedMuseMarker[]>();
  for (const marker of allMarkers) {
    const list = markersByStream.get(marker.stream.id) ?? [];
    list.push(marker);
    markersByStream.set(marker.stream.id, list);
  }
  let gapCount = 0;
  for (const [streamId, sequences] of sequencesByStream) {
    gapCount += detectSequenceGaps(sequences, markersByStream.get(streamId) ?? []).length;
  }
  if (gapCount > 0) diagnostics.push("sequence_jump");

  const mapped = mapMuseToTape([...live.events, ...childEvents], allMarkers, invalidLines, {
    sessionId: input.sessionId,
    projectId: input.projectId,
    build: input.build,
    observedAt: new Date(observedIso),
  });
  const events = [...mapped.events];
  let quality = mapped.quality;
  let reconciled: FinalizeResult["reconciled"] = null;

  if (input.exportDoc !== undefined) {
    const parsed = parseExportDocument(input.exportDoc);
    diagnostics.push(...parsed.diagnostics);
    const liveKeys = new Set<string>();
    for (const record of [...live.events, ...childEvents]) {
      liveKeys.add(`${record.stream.id}:${record.sequence}`);
    }
    const merged = reconcileExport(liveKeys, parsed.records);
    reconciled = {
      added: merged.addedKeys.length,
      merged: merged.mergedKeys.length,
      schemaVersion: parsed.schemaVersion,
    };
    const byKey = new Map(parsed.records.map((record) => [record.key, record]));
    for (const key of merged.addedKeys) {
      const record = byKey.get(key);
      if (!record) continue;
      const { event } = buildTapeEvent({
        kind: "agent.unknown",
        payload: record.raw,
        payloadType: null,
        recordType: "export",
        sequence: null,
        ts: null,
        recordKey: `muse:${input.sessionId}:export:${key}`,
        links: emptyLinks(),
        diagnostics: ["export_recovery"],
        sessionId: input.sessionId,
        projectId: input.projectId,
        build: input.build,
        observedAt: observedIso,
        tapeSeq: events.length,
        schema: parsed.schemaVersion !== null ? `export/${parsed.schemaVersion}` : null,
        origin: "export",
      });
      events.push(event);
    }
    diagnostics.push(
      `export_reconciled:added=${merged.addedKeys.length}:merged=${merged.mergedKeys.length}`,
    );
    if (merged.addedKeys.length > 0) quality = "partial";
  }

  if (diagnostics.length > 0 && quality === "full") quality = "partial";
  return { events, quality, diagnostics, reconciled };
}
