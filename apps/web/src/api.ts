import type {
  AnswerConfidence,
  ArchitectureChatResponse,
  ArchitectureGetResponse,
  ArchitecturePatch,
  AskEvidence,
  AskRequest,
  AskResponse,
  AskThread,
  Change,
  ChangeId,
  CheckAttemptV2,
  ChecksV2Response,
  EngagementEvent,
  EngagementState,
  Progress,
  ProgressState,
  ProjectFilesResponse,
  ProjectLearnResponse,
  ProjectSummary,
  ProjectTechStack,
  SessionHistoryResponse,
  SessionReview,
  SessionStory,
  SessionSummary,
} from "@echo/contracts";

/** Backstop so a stuck server can never stick the UI; above the server's own deadline. */
const CHECK_REQUEST_TIMEOUT_MS = 200_000;

/** Thrown when the session hasn't gone quiet yet — no changes exist to read. */
export class ChangesNotReadyError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} has not gone quiet yet`);
    this.name = "ChangesNotReadyError";
    this.sessionId = sessionId;
  }
}

/** Thrown when the session hasn't gone quiet yet — no story exists and none will generate this visit. */
export class StoryNotReadyError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} has not gone quiet yet`);
    this.name = "StoryNotReadyError";
    this.sessionId = sessionId;
  }
}

/** Reader payload: ordered changes, stored progress rows, digest-built summary, liveness. */
export type SessionChangesResponse = {
  changes: Change[];
  progress: Progress[];
  summary: string;
  isLive: boolean;
};

type FetchOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export interface HealthResponse {
  status: string;
  version: string;
  mode: "local" | "demo";
  uptimeMs: number;
}

function requestSignal(options: FetchOptions): AbortSignal | undefined {
  if (options.timeoutMs === undefined) return options.signal;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  return options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

async function postJson<T>(url: string, body: unknown, options: FetchOptions = {}): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: requestSignal(options),
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
  health: () => getJson<HealthResponse>("/api/health"),
  projects: () => getJson<ProjectSummary[]>("/api/projects"),
  project: (projectId: string) =>
    getJson<ProjectSummary>(`/api/projects/${encodeURIComponent(projectId)}`),
  projectFiles: (projectId: string) =>
    getJson<ProjectFilesResponse>(`/api/projects/${encodeURIComponent(projectId)}/files`),
  learn: (projectId: string) =>
    getJson<ProjectLearnResponse>(`/api/projects/${encodeURIComponent(projectId)}/learn`),
  techStack: (projectId: string) =>
    getJson<ProjectTechStack>(`/api/projects/${encodeURIComponent(projectId)}/tech-stack`),
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
  generateChecksV2: (sessionId: string, signal?: AbortSignal) =>
    postJson<ChecksV2Response>(
      `/api/sessions/${encodeURIComponent(sessionId)}/checks-v2/generate`,
      {},
      { signal, timeoutMs: CHECK_REQUEST_TIMEOUT_MS },
    ),
  checkMe: (sessionId: string, cardId: string, signal?: AbortSignal) =>
    postJson<ChecksV2Response>(
      `/api/sessions/${encodeURIComponent(sessionId)}/checks-v2/check-me`,
      { cardId },
      { signal, timeoutMs: CHECK_REQUEST_TIMEOUT_MS },
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
      { timeoutMs: CHECK_REQUEST_TIMEOUT_MS },
    ),
  skipChecksV2: (sessionId: string) =>
    postJson<{ status: "skipped" }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/checks-v2/skip`,
      {},
    ),
  story: async (sessionId: string): Promise<SessionStory> => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/story`);
    if (response.status === 202) {
      // The session hasn't gone quiet yet: no story to show, and none will
      // generate until a minute of tape silence has passed.
      throw new StoryNotReadyError(sessionId);
    }
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
  changes: async (sessionId: string): Promise<SessionChangesResponse> => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/changes`);
    if (response.status === 202) {
      // The session hasn't gone quiet yet: no changes to read, and none will
      // exist until the pipeline groups the first snapshot-pair diff.
      throw new ChangesNotReadyError(sessionId);
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(payload?.error?.message ?? `${response.status} ${response.statusText}`);
    }
    const body = (await response.json()) as Partial<SessionChangesResponse> | null;
    // The server owns the envelope; default defensively so a sparse payload
    // renders an empty reader instead of throwing on first paint.
    return {
      changes: Array.isArray(body?.changes) ? body.changes : [],
      progress: Array.isArray(body?.progress) ? body.progress : [],
      summary: typeof body?.summary === "string" ? body.summary : "",
      isLive: body?.isLive === true,
    };
  },
  recordProgress: (
    sessionId: string,
    input: { changeId: ChangeId; version: number; state: ProgressState },
  ) => postJson<Progress>(`/api/sessions/${encodeURIComponent(sessionId)}/progress`, input),
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
  architecture: (projectId: string) =>
    getJson<ArchitectureGetResponse>(`/api/projects/${encodeURIComponent(projectId)}/architecture`),
  generateArchitecture: (projectId: string) =>
    postJson<{ started: boolean }>(
      `/api/projects/${encodeURIComponent(projectId)}/architecture/generate`,
      {},
    ),
  chatArchitecture: async (
    projectId: string,
    input: { message: string; pinnedNodeId: string | null },
    options: { signal?: AbortSignal } = {},
  ): Promise<ArchitectureChatResponse> => {
    // Custom shape (not postJson): an invalid patch still carries the model's
    // answer in the error details, and the UI shows both.
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/architecture/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: options.signal,
      },
    );
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string; details?: unknown };
    } | null;
    if (!response.ok) {
      const error = new Error(
        body?.error?.message ?? `${response.status} ${response.statusText}`,
      ) as Error & { details?: unknown };
      error.details = body?.error?.details;
      throw error;
    }
    return body as ArchitectureChatResponse;
  },
  applyArchitecturePatch: (projectId: string, patch: ArchitecturePatch) =>
    postJson<{ version: number; droppedEdges: Array<{ from: string; to: string }> }>(
      `/api/projects/${encodeURIComponent(projectId)}/architecture/apply`,
      { patch },
    ),
  undoArchitecture: (projectId: string) =>
    postJson<{ version: number }>(
      `/api/projects/${encodeURIComponent(projectId)}/architecture/undo`,
      {},
    ),
};

export function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
