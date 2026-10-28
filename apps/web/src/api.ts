import type {
  AnswerConfidence,
  AskEvidence,
  AskRequest,
  AskResponse,
  AskThread,
  CheckAttemptV2,
  ChecksV2Response,
  EngagementEvent,
  EngagementState,
  ProjectSummary,
  SessionHistoryResponse,
  SessionReview,
  SessionStory,
  SessionSummary,
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
  review: (sessionId: string) =>
    getJson<SessionReview>(`/api/sessions/${encodeURIComponent(sessionId)}/review`),
  ask: (sessionId: string, input: AskRequest) =>
    postJson<AskResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/ask`, input),
  askThread: (sessionId: string) =>
    getJson<AskThread>(`/api/sessions/${encodeURIComponent(sessionId)}/ask/thread`),
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

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
