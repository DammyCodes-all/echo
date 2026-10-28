import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AskRequest,
  type AskResponse,
  type AskThread,
  AskThreadSchema,
  type ChangeCard,
  type SessionStory,
  SessionStorySchema,
  type TapeEvent,
  TapeEventKindSchema,
} from "@echo/contracts";
import { type EchoDb, getArtifactRef, getSession, readAllEvents, type StoredEvent } from "@echo/db";
import { type ModelConfig, ModelError, modelConfigFromEnv, requestJson } from "@echo/model";
import { redactJson } from "@echo/redaction";
import {
  buildEvidenceBundle,
  parseAnswer,
  type StructuredAnswer,
  validateCitations,
} from "@echo/retrieval";

export interface AskOutcome {
  status: number;
  body: AskResponse | { error: { code: string; message: string } };
}

export interface ThreadOutcome {
  status: number;
  body: AskThread | { error: { code: string; message: string } };
}

export interface AskLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

interface AskServiceOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  /** Content-free diagnostics only; defaults to a silent noop (tests). */
  log?: AskLogger;
}

const SYSTEM_PROMPT = [
  "Answer only from the supplied evidence bundle.",
  "Cite every factual claim with one or more evidence_ids.",
  "Distinguish what was observed (tool calls, results, snapshots) from what the agent wrote (agent_stated).",
  "Never present an inference about intent as the agent's reasoning.",
  "If the evidence does not support an answer, refuse with refusal_reason not_on_tape.",
  "Do not use outside knowledge about the repository, the libraries or the user.",
  "Keep the answer short; the UI supplies the detail.",
  'Reply with JSON: {"refusal": boolean, "refusal_reason": "not_on_tape"|"insufficient_evidence"|"ambiguous_question"|"model_error"|null, "answer": string, "claims": [{"text": string, "evidence_ids": string[], "quote": string|null}], "uncertainty": "low"|"medium"|"high"}.',
].join("\n");

export function storedToTape(
  sessionId: string,
  projectId: string,
  stored: StoredEvent,
): TapeEvent | null {
  const kind = TapeEventKindSchema.safeParse(stored.kind);
  if (!kind.success) return null;
  const redaction =
    stored.redaction !== null &&
    typeof stored.redaction === "object" &&
    typeof (stored.redaction as { version?: unknown }).version === "string"
      ? {
          version: (stored.redaction as { version: string }).version,
          findings: 0,
        }
      : { version: "unknown", findings: 0 };
  return {
    v: 1,
    tape_seq: stored.tape_seq,
    event_id: stored.event_id,
    record_key: stored.record_key,
    session_id: sessionId,
    project_id: projectId,
    kind: kind.data,
    ts: stored.ts,
    observed_at: stored.observed_at,
    source: {
      agent: "muse",
      adapter: "db",
      adapter_version: "0.1.0",
      build: null,
      schema: null,
      record_type: null,
      payload_type: null,
      sequence: null,
      durability: null,
      origin: "import",
    },
    links: {
      turn_id: null,
      tool_call_id: stored.tool_call_id,
      batch_id: null,
      parent_session_id: null,
      subagent_id: null,
      snapshot: null,
    },
    payload: stored.payload,
    redaction,
    diagnostics: [],
  };
}

function bundlePrompt(question: string, evidence: string): string {
  return `Question: ${question}\n\nEvidence bundle:\n${evidence}`;
}

function formatBundle(
  items: Array<{
    evidenceId: string;
    kind: string;
    label: string;
    ts: string;
    text: string;
    filePath: string | null;
  }>,
): string {
  return items
    .map(
      (item) =>
        `[${item.evidenceId}] ${item.kind}/${item.label} ${item.ts}${item.filePath ? ` ${item.filePath}` : ""}\n${item.text}`,
    )
    .join("\n\n");
}

function parseModelAnswer(value: unknown): StructuredAnswer {
  const parsed = parseAnswer(value);
  if (!parsed) throw new ModelError("invalid_response", "model answer failed boundary parse");
  return parsed;
}

/**
 * Server-side Q&A: deterministic retrieval over the session tape, one
 * structured model call, server-side citation validation. Refusals
 * (nothing relevant on the tape) never reach the model. Answered, partial
 * and refused outcomes persist to a per-session thread artifact; model
 * transport failures and redaction failures never persist.
 */
export function createAskService(db: EchoDb, dataDir: string, options: AskServiceOptions = {}) {
  const cache = new Map<string, AskResponse>();
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log: AskLogger = options.log ?? {
    info: () => {},
    error: () => {},
  };

  function modelOff(): boolean {
    return env.ECHO_MODEL === "off";
  }

  function resolveConfig(): ModelConfig {
    return modelConfigFromEnv(env);
  }

  function threadArtifactPath(projectId: string, sessionId: string): string {
    return join(
      dataDir,
      "projects",
      projectId,
      "sessions",
      sessionId,
      "artifacts",
      "ask_thread.json",
    );
  }

  function storyArtifactPath(projectId: string, sessionId: string): string {
    return join(dataDir, "projects", projectId, "sessions", sessionId, "artifacts", "story.json");
  }

  function loadThread(projectId: string, sessionId: string): AskThread {
    const empty = (): AskThread => ({
      schemaVersion: 1,
      sessionId,
      updatedAt: new Date().toISOString(),
      messages: [],
    });
    const path = threadArtifactPath(projectId, sessionId);
    if (!existsSync(path)) return empty();
    try {
      const parsed = AskThreadSchema.safeParse(JSON.parse(readFileSync(path, "utf8")) as unknown);
      // A corrupt artifact resets to an empty thread instead of 500ing: one
      // bad write must not brick the whole Ask Why history, and gaps are
      // data — the missing turns simply stay missing.
      if (!parsed.success) return empty();
      return parsed.data;
    } catch {
      return empty();
    }
  }

  /** Redacts then writes; false means nothing was persisted (fail closed). */
  function persistThread(projectId: string, thread: AskThread): boolean {
    let scanned: unknown;
    try {
      scanned = redactJson(thread).value;
    } catch (error) {
      // Content-free diagnostic: never log the payload that failed.
      log.error(
        { session_id: thread.sessionId, err: String(error) },
        "ask thread redaction failed",
      );
      return false;
    }
    const parsed = AskThreadSchema.safeParse(scanned);
    if (!parsed.success) {
      log.error({ session_id: thread.sessionId }, "ask thread redaction failed schema check");
      return false;
    }
    const path = threadArtifactPath(projectId, thread.sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(parsed.data, null, 2)}\n`);
    return true;
  }

  function loadStory(sessionId: string, projectId: string): SessionStory | null {
    // Prefer the artifact-ref path (restart-safe); fall back to the
    // conventional layout both the story service and tests write to.
    const ref = getArtifactRef(db, sessionId, "story");
    const candidates =
      ref && typeof ref.path === "string" && ref.path.length > 0
        ? [ref.path, storyArtifactPath(projectId, sessionId)]
        : [storyArtifactPath(projectId, sessionId)];
    const seen = new Set<string>();
    for (const path of candidates) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (!existsSync(path)) continue;
      try {
        const parsed = SessionStorySchema.safeParse(
          JSON.parse(readFileSync(path, "utf8")) as unknown,
        );
        if (parsed.success) return parsed.data;
      } catch {
        // Unusable story counts as no story; the caller reports unknown card.
      }
    }
    return null;
  }

  function resolveScope(
    input: AskRequest,
    card: ChangeCard | null,
  ): { filePath?: string; symbols: string[] } {
    // constituentHunkIds identify the card but are not retrieval input: the
    // bundle builder only scopes on filePath/symbols, so only touches[] enters.
    if (input.filePath) return { filePath: input.filePath, symbols: input.symbols };
    if (!card) return { symbols: input.symbols };
    if (card.touches.length === 1 && typeof card.touches[0] === "string") {
      return { filePath: card.touches[0], symbols: input.symbols };
    }
    // Multi-file (or touch-less) card: the builder has no multi-file scope,
    // so every touched path joins the symbol terms instead (same token match).
    return { symbols: [...input.symbols, ...card.touches] };
  }

  /** Appends one user + one assistant message; false = redaction failed, nothing written. */
  function appendTurn(
    projectId: string,
    sessionId: string,
    input: AskRequest,
    cardId: string | null,
    response: AskResponse,
  ): boolean {
    const thread = loadThread(projectId, sessionId);
    const now = new Date().toISOString();
    const base = `${sessionId}:${thread.messages.length}:${randomUUID()}`;
    const userId = `msg_${createHash("sha256").update(`user:${base}`).digest("hex").slice(0, 12)}`;
    const assistantId = `msg_${createHash("sha256").update(`assistant:${base}`).digest("hex").slice(0, 12)}`;
    thread.messages.push(
      { id: userId, role: "user", text: input.question, cardId, response: null, createdAt: now },
      {
        id: assistantId,
        role: "assistant",
        // Refusals carry an empty answer; the message text still needs a
        // non-empty body so the thread artifact stays schema-valid.
        text:
          response.answer.length > 0
            ? response.answer
            : `Refused (${response.refusalReason ?? "not_on_tape"})`,
        cardId,
        response,
        createdAt: now,
      },
    );
    thread.updatedAt = now;
    return persistThread(projectId, thread);
  }

  function redactionFailed(): AskOutcome {
    return {
      status: 500,
      body: {
        error: { code: "redaction_failed", message: "ask thread failed the redaction gate" },
      },
    };
  }

  async function answer(sessionId: string, input: AskRequest): Promise<AskOutcome> {
    const session = getSession(db, sessionId);
    if (!session) {
      return {
        status: 404,
        body: { error: { code: "not_found", message: "unknown session" } },
      };
    }
    const cardId = input.cardId ?? null;
    let card: ChangeCard | null = null;
    if (cardId !== null) {
      const story = loadStory(sessionId, session.projectId);
      const found = story?.cards.find((entry) => entry.id === cardId) ?? null;
      if (!found) {
        return {
          status: 400,
          body: { error: { code: "invalid_request", message: "unknown card" } },
        };
      }
      card = found;
    }
    const stored = readAllEvents(db, sessionId);
    const events: TapeEvent[] = [];
    for (const event of stored) {
      const tape = storedToTape(session.id, session.projectId, event);
      if (tape) events.push(tape);
    }
    const scope = resolveScope(input, card);
    const bundle = buildEvidenceBundle(events, {
      question: input.question,
      ...(scope.filePath ? { filePath: scope.filePath } : {}),
      symbols: scope.symbols,
    });
    if (bundle.items.length === 0) {
      const refused: AskResponse = {
        status: "refused",
        answer: "",
        claims: [],
        refusalReason: "not_on_tape",
        uncertainty: "low",
        bundleHash: bundle.bundleHash,
        searchedScope: bundle.searchedScope,
        evidence: [],
        cached: false,
      };
      // Pre-model refusal is deterministic from the tape, so it persists like
      // any other 200 outcome. Only model calls fail closed without persisting.
      if (!appendTurn(session.projectId, sessionId, input, cardId, refused)) {
        return redactionFailed();
      }
      return { status: 200, body: refused };
    }

    const cacheKey = createHash("sha256")
      .update(
        `${input.question}\n${bundle.bundleHash}\n${env.META_MODEL_ID ?? "muse-spark-1.3-contributor"}`,
      )
      .digest("hex");
    const hit = cache.get(cacheKey);
    if (hit) {
      const body = { ...hit, cached: true };
      // Cache hits still append to the thread: same response, new message ids.
      if (!appendTurn(session.projectId, sessionId, input, cardId, body)) {
        return redactionFailed();
      }
      return { status: 200, body };
    }
    if (modelOff()) {
      return {
        status: 503,
        body: { error: { code: "model_error", message: "ECHO_MODEL=off and no cached answer" } },
      };
    }

    let config: ModelConfig;
    try {
      config = resolveConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : "model misconfigured";
      const code = error instanceof ModelError ? error.code : "model_error";
      return { status: 503, body: { error: { code, message } } };
    }

    let structured: StructuredAnswer;
    try {
      const result = await requestJson(
        config,
        [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: bundlePrompt(input.question, formatBundle(bundle.items)),
          },
        ],
        parseModelAnswer,
        { fetchImpl, retryMaxTokens: Math.max(config.maxTokens * 2, 8192) },
      );
      structured = result.value;
    } catch (error) {
      const message = error instanceof Error ? error.message : "model call failed";
      const code = error instanceof ModelError ? error.code : "model_error";
      return { status: 502, body: { error: { code, message } } };
    }

    const validation = validateCitations(bundle, structured);
    const response: AskResponse =
      validation.status === "refused"
        ? {
            status: "refused",
            answer: "",
            claims: [],
            refusalReason: validation.refusalReason,
            uncertainty: structured.uncertainty,
            bundleHash: bundle.bundleHash,
            searchedScope: bundle.searchedScope,
            evidence: bundle.items,
            cached: false,
          }
        : {
            status: validation.status,
            answer: structured.answer,
            claims: validation.validClaims,
            refusalReason: null,
            uncertainty: structured.uncertainty,
            bundleHash: bundle.bundleHash,
            searchedScope: bundle.searchedScope,
            evidence: bundle.items,
            cached: false,
          };
    // The turn only counts once the thread artifact is durably updated: a
    // redaction failure drops the answer (500) instead of persisting it.
    if (!appendTurn(session.projectId, sessionId, input, cardId, response)) {
      return redactionFailed();
    }
    cache.set(cacheKey, response);
    return { status: 200, body: response };
  }

  async function thread(sessionId: string): Promise<ThreadOutcome> {
    const session = getSession(db, sessionId);
    if (!session) {
      return {
        status: 404,
        body: { error: { code: "not_found", message: "unknown session" } },
      };
    }
    return { status: 200, body: loadThread(session.projectId, sessionId) };
  }

  return { answer, thread };
}
