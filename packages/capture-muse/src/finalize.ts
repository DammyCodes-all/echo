import type { CaptureQuality, TapeEvent } from "@echo/contracts";
import { parseExportDocument, reconcileExport } from "./export";
import { buildTapeEvent, emptyLinks, isoFromUs, mapMuseToTape } from "./map";
import type { ParsedMuseEvent, ParsedMuseMarker } from "./reader";
import { detectSequenceGaps, parseMuseContent } from "./reader";

export interface ChildLog {
  id: string;
  content: string;
}

export interface FinalizeInput {
  sessionId: string;
  projectId: string;
  build: string | null;
  liveContent: string;
  childContents?: ChildLog[];
  exportDoc?: unknown;
  observedAt?: Date;
}

export interface FinalizeResult {
  events: TapeEvent[];
  quality: CaptureQuality;
  diagnostics: string[];
  reconciled: { added: number; merged: number; schemaVersion: number | null } | null;
}

// A referenced-but-absent child log is a gap, not an inference license:
// record the absence (linked to its parent) and never invent its actions.
// Only the explicit child_session_id linkage key counts; task_stream ids
// live in a different namespace and guessing across it would fabricate links.
function collectReferencedChildIds(events: ParsedMuseEvent[], selfId: string): Map<string, number> {
  const found = new Map<string, number>();
  const visit = (value: unknown, recordedAtUs: number): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, recordedAtUs);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (key === "child_session_id" && typeof entry === "string" && entry.length > 0) {
          if (entry !== selfId && !found.has(entry)) found.set(entry, recordedAtUs);
        } else {
          visit(entry, recordedAtUs);
        }
      }
    }
  };
  for (const event of events) visit(event.payload, event.recordedAtUs);
  return found;
}

// Pure composition of reader + map + export reconciliation.
// Daemon-side finalization calls this, then owns persistence (tape, shadow
// Git, SQLite). Export-only records are preserved as agent.unknown with
// origin export; precise kinds are never inferred from the export frame.
export function finalizeMuseSession(input: FinalizeInput): FinalizeResult {
  const observedIso = (input.observedAt ?? new Date()).toISOString();
  const live = parseMuseContent(input.liveContent);
  const childParses = (input.childContents ?? []).map((child) => ({
    id: child.id,
    parsed: parseMuseContent(child.content),
  }));
  const childEvents = childParses.flatMap((child) => child.parsed.events);
  const allMarkers = [...live.markers, ...childParses.flatMap((child) => child.parsed.markers)];
  const invalidLines =
    live.invalidLines + childParses.reduce((total, child) => total + child.parsed.invalidLines, 0);
  const diagnostics: string[] = [];
  if (live.truncatedTail || childParses.some((child) => child.parsed.truncatedTail)) {
    diagnostics.push("truncated_tail");
  }

  const sequencesByStream = new Map<string, number[]>();
  const tsByStreamSeq = new Map<string, string>();
  for (const event of [...live.events, ...childEvents]) {
    const list = sequencesByStream.get(event.stream.id) ?? [];
    list.push(event.sequence);
    sequencesByStream.set(event.stream.id, list);
    tsByStreamSeq.set(`${event.stream.id}:${event.sequence}`, isoFromUs(event.recordedAtUs));
  }
  const markersByStream = new Map<string, ParsedMuseMarker[]>();
  for (const marker of allMarkers) {
    const list = markersByStream.get(marker.stream.id) ?? [];
    list.push(marker);
    markersByStream.set(marker.stream.id, list);
  }
  const gaps: Array<{ streamId: string; from: number; to: number }> = [];
  for (const [streamId, sequences] of sequencesByStream) {
    for (const gap of detectSequenceGaps(sequences, markersByStream.get(streamId) ?? [])) {
      gaps.push({ streamId, from: gap.fromSequence, to: gap.toSequence });
    }
  }
  if (gaps.length > 0) diagnostics.push("sequence_jump");

  const mapped = mapMuseToTape([...live.events, ...childEvents], allMarkers, invalidLines, {
    sessionId: input.sessionId,
    projectId: input.projectId,
    build: input.build,
    observedAt: new Date(observedIso),
  });
  const events = [...mapped.events];
  let quality = mapped.quality;
  let reconciled: FinalizeResult["reconciled"] = null;

  // Gaps are evidence: one capture.gap per missing range, keyed
  // deterministically so re-finalization dedupes instead of duplicating.
  for (const gap of gaps) {
    const { event } = buildTapeEvent({
      kind: "capture.gap",
      payload: {
        code: "sequence_jump",
        stream_id: gap.streamId,
        from_sequence: gap.from,
        to_sequence: gap.to,
      },
      payloadType: null,
      recordType: "gap",
      sequence: null,
      ts: tsByStreamSeq.get(`${gap.streamId}:${gap.from}`) ?? observedIso,
      recordKey: `muse:${input.sessionId}:gap:${gap.streamId}:${gap.from}-${gap.to}`,
      links: emptyLinks(),
      diagnostics: ["sequence_jump"],
      sessionId: input.sessionId,
      projectId: input.projectId,
      build: input.build,
      observedAt: observedIso,
      tapeSeq: events.length,
      schema: null,
      origin: "live",
    });
    events.push(event);
  }

  const presentChildIds = new Set<string>();
  for (const child of input.childContents ?? []) presentChildIds.add(child.id);
  for (const event of childEvents) presentChildIds.add(event.stream.id);
  for (const [childId, recordedAtUs] of collectReferencedChildIds(
    [...live.events, ...childEvents],
    input.sessionId,
  )) {
    if (presentChildIds.has(childId)) continue;
    diagnostics.push(`missing_child:${childId}`);
    const { event } = buildTapeEvent({
      kind: "capture.gap",
      payload: { code: "missing_child", subagent_id: childId },
      payloadType: null,
      recordType: "gap",
      sequence: null,
      ts: isoFromUs(recordedAtUs),
      recordKey: `muse:${input.sessionId}:gap:missing-child:${childId}`,
      links: { ...emptyLinks(), subagent_id: childId, parent_session_id: input.sessionId },
      diagnostics: ["missing_child"],
      sessionId: input.sessionId,
      projectId: input.projectId,
      build: input.build,
      observedAt: observedIso,
      tapeSeq: events.length,
      schema: null,
      origin: "live",
    });
    events.push(event);
  }

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
