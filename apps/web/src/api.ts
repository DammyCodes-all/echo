import type {
  ProjectSummary,
  SessionSummary,
  SnapshotFile,
  SnapshotFileContent,
  SnapshotSummary,
  StoredEvent,
} from "@echo/contracts";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

export const api = {
  projects: () => getJson<ProjectSummary[]>("/api/projects"),
  sessions: (projectId: string) =>
    getJson<SessionSummary[]>(`/api/projects/${encodeURIComponent(projectId)}/sessions`),
  session: (sessionId: string) =>
    getJson<SessionSummary>(`/api/sessions/${encodeURIComponent(sessionId)}`),
  events: async (sessionId: string): Promise<StoredEvent[]> => {
    const result = await getJson<{ events: StoredEvent[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/events?limit=1000`,
    );
    return result.events;
  },
  snapshots: (sessionId: string) =>
    getJson<SnapshotSummary[]>(`/api/sessions/${encodeURIComponent(sessionId)}/snapshots`),
  snapshotFiles: (sessionId: string, commit: string) =>
    getJson<SnapshotFile[]>(
      `/api/sessions/${encodeURIComponent(sessionId)}/snapshots/${encodeURIComponent(commit)}/files`,
    ),
  fileContent: (sessionId: string, commit: string, path: string) =>
    getJson<SnapshotFileContent>(
      `/api/sessions/${encodeURIComponent(sessionId)}/snapshots/${encodeURIComponent(commit)}/blob?path=${encodeURIComponent(path)}`,
    ),
};

export function summarizePayload(event: StoredEvent): string {
  const payload = event.payload;
  if (payload === null || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  if (typeof record.name === "string") {
    const input = record.input;
    const path =
      input !== null &&
      typeof input === "object" &&
      typeof (input as { path?: unknown }).path === "string"
        ? (input as { path: string }).path
        : null;
    return path === null ? record.name : `${record.name} ${path}`;
  }
  if (typeof record.text === "string") return record.text.slice(0, 140);
  if (Array.isArray(record.parts)) return `${record.parts.length} part(s)`;
  if (typeof record.title === "string") return record.title;
  if (typeof record.outcome === "string") {
    const error = record.error as { type?: unknown } | null | undefined;
    return typeof error?.type === "string" ? `${record.outcome} · ${error.type}` : record.outcome;
  }
  if (typeof record.code === "string") {
    return typeof record.detail === "string"
      ? `${record.code} · ${record.detail}`
      : `${record.code}: ${JSON.stringify(record).slice(0, 120)}`;
  }
  if (typeof record.trigger === "string" && typeof record.commit_oid === "string") {
    return `${record.trigger} · ${String(record.file_count)} files · ${String(record.total_bytes)} B`;
  }
  const serialized = JSON.stringify(payload);
  return serialized.length > 140 ? `${serialized.slice(0, 140)}…` : serialized;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
