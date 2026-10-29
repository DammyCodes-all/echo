import type { DatabaseSync } from "node:sqlite";

export interface OpenCodeSessionSummary {
  id: string;
  /** Owning session for Task-spawned subagents; null for top-level sessions. */
  parentId: string | null;
  title: string | null;
  directory: string | null;
  model: string | null;
  agent: string | null;
  timeCreated: number | null;
  timeUpdated: number | null;
}

export interface OpenCodeMessageRow {
  id: string;
  type: string;
  seq: number | null;
  timeCreated: number | null;
  data: Record<string, unknown>;
}

export interface OpenCodeSkippedRow {
  id: string;
  seq: number | null;
  reason: string;
}

export interface OpenCodeMessageRead {
  messages: OpenCodeMessageRow[];
  skipped: OpenCodeSkippedRow[];
}

export { projectIdForDirectory } from "@echo/core";

export function sessionModelLabel(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      const model = parsed as { id?: unknown; providerID?: unknown };
      if (typeof model.id === "string" && model.id.length > 0) {
        return typeof model.providerID === "string" && model.providerID.length > 0
          ? `${model.providerID}/${model.id}`
          : model.id;
      }
    }
  } catch {
    // plain-string model ids are valid in older rows
  }
  return raw;
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function listOpenCodeSessions(db: DatabaseSync): OpenCodeSessionSummary[] {
  const rows = db
    .prepare(
      "SELECT id, parent_id, title, directory, model, agent, time_created, time_updated FROM session_v2 ORDER BY time_created DESC",
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    parentId: str(row.parent_id),
    title: str(row.title),
    directory: str(row.directory),
    model: str(row.model),
    agent: str(row.agent),
    timeCreated: num(row.time_created),
    timeUpdated: num(row.time_updated),
  }));
}

export function readOpenCodeSession(
  db: DatabaseSync,
  sessionId: string,
): OpenCodeSessionSummary | null {
  const row = db
    .prepare(
      "SELECT id, parent_id, title, directory, model, agent, time_created, time_updated FROM session_v2 WHERE id = ?",
    )
    .get(sessionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    parentId: str(row.parent_id),
    title: str(row.title),
    directory: str(row.directory),
    model: str(row.model),
    agent: str(row.agent),
    timeCreated: num(row.time_created),
    timeUpdated: num(row.time_updated),
  };
}

export function readOpenCodeMessages(db: DatabaseSync, sessionId: string): OpenCodeMessageRead {
  const rows = db
    .prepare(
      "SELECT id, type, seq, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq",
    )
    .all(sessionId) as Array<Record<string, unknown>>;
  const messages: OpenCodeMessageRow[] = [];
  const skipped: OpenCodeSkippedRow[] = [];
  for (const row of rows) {
    const id = String(row.id);
    const seq = num(row.seq);
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(row.data));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        skipped.push({ id, seq, reason: "data_not_object" });
        continue;
      }
      data = parsed as Record<string, unknown>;
    } catch {
      skipped.push({ id, seq, reason: "invalid_json" });
      continue;
    }
    messages.push({
      id,
      type: String(row.type),
      seq,
      timeCreated: num(row.time_created),
      data,
    });
  }
  return { messages, skipped };
}
