import type {
  AnswerCheckRequest,
  AnswerCheckResponse,
  AnswerConfidence,
  AskEvidence,
  AskRequest,
  AskResponse,
  AskThread,
  CheckAttemptV2,
  ChecksV2Response,
  EngagementEvent,
  EngagementState,
  GenerateChecksRequest,
  GenerateChecksResponse,
  ProjectSummary,
  SessionChecksResponse,
  SessionHistoryResponse,
  SessionReport,
  SessionReview,
  SessionStory,
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

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
  }
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
  review: (sessionId: string) =>
    getJson<SessionReview>(`/api/sessions/${encodeURIComponent(sessionId)}/review`),
  snapshotFiles: (sessionId: string, commit: string) =>
    getJson<SnapshotFile[]>(
      `/api/sessions/${encodeURIComponent(sessionId)}/snapshots/${encodeURIComponent(commit)}/files`,
    ),
  fileContent: (sessionId: string, commit: string, path: string) =>
    getJson<SnapshotFileContent>(
      `/api/sessions/${encodeURIComponent(sessionId)}/snapshots/${encodeURIComponent(commit)}/blob?path=${encodeURIComponent(path)}`,
    ),
  ask: (sessionId: string, input: AskRequest) =>
    postJson<AskResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/ask`, input),
  askThread: (sessionId: string) =>
    getJson<AskThread>(`/api/sessions/${encodeURIComponent(sessionId)}/ask/thread`),
  sessionChecks: (sessionId: string) =>
    getJson<SessionChecksResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/checks`),
  generateChecks: (sessionId: string, input: GenerateChecksRequest) =>
    postJson<GenerateChecksResponse>(
      `/api/sessions/${encodeURIComponent(sessionId)}/checks/generate`,
      input,
    ),
  answerCheck: (checkId: string, input: AnswerCheckRequest) =>
    postJson<AnswerCheckResponse>(`/api/checks/${encodeURIComponent(checkId)}/answer`, input),
  checksV2State: (sessionId: string) =>
    getJson<ChecksV2Response>(`/api/sessions/${encodeURIComponent(sessionId)}/checks-v2`),
  generateChecksV2: (sessionId: string) =>
    postJson<ChecksV2Response>(
      `/api/sessions/${encodeURIComponent(sessionId)}/checks-v2/generate`,
      {},
    ),
  checkMe: (sessionId: string, cardId: string) =>
    postJson<ChecksV2Response>(
      `/api/sessions/${encodeURIComponent(sessionId)}/checks-v2/check-me`,
      { cardId },
    ),
  answerCheckV2: (
    sessionId: string,
    input: {
      questionId: string;
      confidence: AnswerConfidence;
      selectedOptionId?: string | null;
      answerText?: string | null;
    },
  ) =>
    postJson<{ attempt: CheckAttemptV2; reveal: { summary: string; evidence: AskEvidence[] } }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/checks-v2/answer`,
      input,
    ),
  skipChecksV2: (sessionId: string) =>
    postJson<{ status: "skipped" }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/checks-v2/skip`,
      {},
    ),
  report: (sessionId: string) =>
    getJson<SessionReport>(`/api/sessions/${encodeURIComponent(sessionId)}/report`),
  story: async (sessionId: string): Promise<SessionStory> => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/story`);
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
    }
    return (await response.json()) as SessionStory;
  },
  sessionHistory: (sessionId: string) =>
    getJson<SessionHistoryResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/history`),
  engagementState: (sessionId: string, cardIds?: string[]) => {
    const query =
      cardIds && cardIds.length > 0 ? `?cardIds=${encodeURIComponent(cardIds.join(","))}` : "";
    return getJson<EngagementState>(
      `/api/sessions/${encodeURIComponent(sessionId)}/engagement${query}`,
    );
  },
  recordEngagement: (sessionId: string, events: EngagementEvent[]) =>
    postJson<{ sessionId: string; inserted: number }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/engagement`,
      { events },
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
