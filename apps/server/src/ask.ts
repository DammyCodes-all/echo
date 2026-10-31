import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AskRequest,
  type AskResponse,
  type AskThread,
  AskThreadSchema,
  CHANGES_FILE_NAME,
  type Change,
  type ChangeCard,
  ChangeIdSchema,
  ChangeSchema,
  type SessionStory,
  SessionStorySchema,
  type TapeEvent,
  TapeEventKindSchema,
} from "@echo/contracts";
import { type EchoDb, getArtifactRef, getSession, readAllEvents, type StoredEvent } from "@echo/db";
import {
  type ChatUsage,
  type ModelConfig,
  ModelError,
  modelConfigFromEnv,
  requestJson,
} from "@echo/model";
import { redactJson } from "@echo/redaction";
import {
  buildEvidenceBundle,
  type EvidenceBundle,
  parseAnswer,
  type StructuredAnswer,
  validateCitations,
} from "@echo/retrieval";

export interface AskOutcome {
  status: number;
  body: AskResponse | { error: { code: string; message: string } };
  /** Token usage of the model call behind this outcome, when one ran. */
  usage?: ChatUsage | null;
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
  /**
   * Demo mode: thread turns live in memory seeded from the baked file, and
   * no thread file is ever written. Each service instance owns its overlay
   * (one per demo visitor).
   */
  demo?: boolean;
}

const SYSTEM_PROMPT = [
  "Answer only from the supplied evidence bundle.",
  "Cite every factual claim with one or more evidence_ids.",
  "Distinguish what was observed (tool calls, results, snapshots) from what the agent wrote (agent_stated).",
  "Never present an inference about intent as the agent's reasoning.",
  "If the evidence supports only part of the question, answer that part and leave the rest unclaimed; refuse with refusal_reason not_on_tape only when no part of the question is answerable from the evidence.",
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

function bundlePrompt(question: string, evidence: string, scopeNote: string | null): string {
  const scope = scopeNote === null ? "" : `Scope: ${scopeNote}\n\n`;
  return `${scope}Question: ${question}\n\nEvidence bundle:\n${evidence}`;
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

  const demoThreads = new Map<string, AskThread>();

  function loadThread(projectId: string, sessionId: string): AskThread {
    if (options.demo === true) {
      // Copies out: appendTurn mutates before persisting, so sharing the
      // cached object would let a failed redaction gate corrupt the overlay.
      const key = `${projectId}/${sessionId}`;
      const cached = demoThreads.get(key);
      if (cached) return structuredClone(cached);
      const seeded = loadThreadFile(projectId, sessionId);
      demoThreads.set(key, seeded);
      return structuredClone(seeded);
    }
    return loadThreadFile(projectId, sessionId);
  }

  function loadThreadFile(projectId: string, sessionId: string): AskThread {
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

  /** Redaction gate + schema check shared by the file and demo-memory sinks. */
  function scanThread(thread: AskThread): AskThread | null {
    let scanned: unknown;
    try {
      scanned = redactJson(thread).value;
    } catch (error) {
      // Content-free diagnostic: never log the payload that failed.
      log.error(
        { session_id: thread.sessionId, err: String(error) },
        "ask thread redaction failed",
      );
      return null;
    }
    const parsed = AskThreadSchema.safeParse(scanned);
    if (!parsed.success) {
      log.error({ session_id: thread.sessionId }, "ask thread redaction failed schema check");
      return null;
    }
    return parsed.data;
  }

  /** Redacts then writes; false means nothing was persisted (fail closed). */
  function persistThread(projectId: string, thread: AskThread): boolean {
    const parsed = scanThread(thread);
    if (!parsed) return false;
    if (options.demo === true) {
      demoThreads.set(`${projectId}/${thread.sessionId}`, parsed);
      return true;
    }
    const path = threadArtifactPath(projectId, thread.sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
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

  function loadChanges(sessionId: string, projectId: string): { changes: Change[] } | null {
    // Mirrors the changes service layout (sessions/<id>/changes.json) without
    // importing it: the server composes packages, and this stays a reader.
    // A corrupt artifact reads as missing, so the caller reports unknown
    // change instead of 500ing; the pipeline regen owns the repair.
    const path = join(dataDir, "projects", projectId, "sessions", sessionId, CHANGES_FILE_NAME);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object") return null;
      const raw = (parsed as Record<string, unknown>).changes;
      if (!Array.isArray(raw)) return null;
      const changes: Change[] = [];
      for (const entry of raw) {
        const change = ChangeSchema.safeParse(entry);
        if (change.success) changes.push(change.data);
      }
      return { changes };
    } catch {
      return null;
    }
  }

  function resolveScope(
    input: AskRequest,
    card: { touches: string[] } | null,
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

  /**
   * Reader change anchor (ADR 0014 §e): an explicit changeId, or a c_ id
   * carried in cardId for callers on the frozen AskRequest shape. Anything
   * else falls through to the legacy story-card path.
   */
  function requestedChangeId(input: AskRequest & { changeId?: unknown }): string | null {
    const explicit = input.changeId;
    if (typeof explicit === "string" && explicit.length > 0) return explicit;
    if (typeof input.cardId === "string" && ChangeIdSchema.safeParse(input.cardId).success) {
      return input.cardId;
    }
    return null;
  }

  /** Slice membership is by recorded input path; prompts join via mention (same rule the grouping uses). */
  function eventFileOf(event: TapeEvent): string | null {
    const payload = event.payload;
    if (payload !== null && typeof payload === "object") {
      const input = (payload as Record<string, unknown>).input;
      if (input !== null && typeof input === "object") {
        const path = (input as Record<string, unknown>).path;
        if (typeof path === "string" && path.length > 0) return path;
      }
    }
    return null;
  }

  function mentionsFiles(text: string, files: Set<string>): boolean {
    const lower = text.toLowerCase();
    for (const file of files) {
      const name = file.toLowerCase();
      const base = name.split("/").pop() ?? "";
      if (lower.includes(name) || (base.length > 0 && lower.includes(base))) return true;
    }
    return false;
  }

  function momentTextOf(event: TapeEvent): string | null {
    if (event.kind !== "prompt.submitted" && event.kind !== "model.response") return null;
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") return null;
    const record = payload as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (typeof record.summary === "string") return record.summary;
    return null;
  }

  /** Tape events for one change: file touches plus that moment's prompts/reasoning. */
  function sliceEventsFor(events: TapeEvent[], change: Change): TapeEvent[] {
    const files = new Set(change.files.map((file) => file.path));
    return events.filter((event) => {
      const file = eventFileOf(event);
      if (file !== null && files.has(file)) return true;
      const text = momentTextOf(event);
      return text !== null && text.length > 0 && mentionsFiles(text, files);
    });
  }

  /** Current-change prose, so "what changed" answers without re-deriving the diff. */
  function changeProse(change: Change): string {
    const files = change.files.map((file) => file.path).join(", ");
    return `${change.title}. ${change.summary} Before: ${change.before.join(" ")} Now: ${change.now.join(" ")} Files: ${files}.`;
  }

  /**
   * Ephemeral scope context, never persisted to the tape: the current change
   * prose plus earlier digests as agent_stated events. Retrieval admits them
   * by the same term-overlap rule as tape events, so an irrelevant question
   * still refuses pre-model.
   */
  function scopeContextEvents(
    sessionId: string,
    projectId: string,
    events: TapeEvent[],
    change: Change,
    earlier: Change[],
  ): TapeEvent[] {
    const last = events.length > 0 ? events[events.length - 1] : null;
    const ts = last?.ts ?? new Date().toISOString();
    const make = (eventId: string, seq: number, content: string): TapeEvent => ({
      v: 1,
      tape_seq: seq,
      event_id: eventId,
      record_key: null,
      session_id: sessionId,
      project_id: projectId,
      kind: "model.response",
      ts,
      observed_at: ts,
      source: {
        agent: "muse",
        adapter: "ask-scope",
        adapter_version: "0.1.0",
        build: null,
        schema: null,
        record_type: null,
        payload_type: null,
        sequence: null,
        durability: "memory",
        origin: "import",
      },
      links: {
        turn_id: null,
        tool_call_id: null,
        batch_id: null,
        parent_session_id: null,
        subagent_id: null,
        snapshot: null,
      },
      payload: { content },
      redaction: { version: "ask-scope", findings: 0 },
      diagnostics: [],
    });
    const out: TapeEvent[] = [];
    earlier.forEach((digest, index) => {
      out.push(
        make(`digest:${digest.id}`, -(index + 1), `Earlier change digest: ${digest.digest}`),
      );
    });
    out.push(make(`change:${change.id}:prose`, -(earlier.length + 1), changeProse(change)));
    return out;
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

  async function answer(
    sessionId: string,
    input: AskRequest & { changeId?: string | null },
  ): Promise<AskOutcome> {
    const session = getSession(db, sessionId);
    if (!session) {
      return {
        status: 404,
        body: { error: { code: "not_found", message: "unknown session" } },
      };
    }
    const stored = readAllEvents(db, sessionId);
    const events: TapeEvent[] = [];
    for (const event of stored) {
      const tape = storedToTape(session.id, session.projectId, event);
      if (tape) events.push(tape);
    }
    // Reader change scope (ADR 0014 §e): the change slice (diff touches +
    // that moment's prompts/reasoning) plus earlier digests only. Thread
    // persistence stays on cardId (h_ or null): the thread schema has no
    // change field, so a c_ anchor persists as null (request-scoped).
    const changeId = requestedChangeId(input);
    let bundle: EvidenceBundle;
    let scopeNote: string | null = null;
    let persistCardId: string | null = null;
    if (changeId !== null) {
      const loaded = loadChanges(sessionId, session.projectId);
      const all = loaded?.changes ?? [];
      const change = all.filter((entry) => entry.id === changeId).pop();
      if (!change) {
        return {
          status: 400,
          body: { error: { code: "invalid_request", message: "unknown change" } },
        };
      }
      const index = all.lastIndexOf(change);
      const earlier = all.slice(0, index).filter((entry) => entry.id !== changeId);
      const files = change.files.map((file) => file.path);
      const scoped = [
        ...sliceEventsFor(events, change),
        ...scopeContextEvents(session.id, session.projectId, events, change, earlier),
      ];
      // Pure term overlap over the pre-filtered slice: exact tokens, no
      // filePath boost, no symbol terms, no synonym/stem expansion (any of
      // those would admit slice events for gibberish and break pre-model
      // refusal). The scope is still reported so answers carry the change
      // file like card-scoped ones do.
      const sliced = buildEvidenceBundle(
        scoped,
        { question: input.question, symbols: [] },
        { strictOverlap: true },
      );
      const single = files.length === 1 && typeof files[0] === "string" ? files[0] : null;
      bundle = {
        ...sliced,
        searchedScope: { eventCount: sliced.searchedScope.eventCount, filePath: single },
      };
      scopeNote = `change ${change.id} (${files.join(", ")}) plus earlier digests`;
    } else {
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
      const scope = resolveScope(input, card);
      bundle = buildEvidenceBundle(events, {
        question: input.question,
        ...(scope.filePath ? { filePath: scope.filePath } : {}),
        symbols: scope.symbols,
      });
      persistCardId = cardId;
    }
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
      if (!appendTurn(session.projectId, sessionId, input, persistCardId, refused)) {
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
      if (!appendTurn(session.projectId, sessionId, input, persistCardId, body)) {
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
    let usage: ChatUsage | null = null;
    try {
      const result = await requestJson(
        config,
        [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: bundlePrompt(input.question, formatBundle(bundle.items), scopeNote),
          },
        ],
        parseModelAnswer,
        { fetchImpl, retryMaxTokens: Math.max(config.maxTokens * 2, 8192) },
      );
      structured = result.value;
      usage = result.usage;
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
    if (!appendTurn(session.projectId, sessionId, input, persistCardId, response)) {
      return redactionFailed();
    }
    cache.set(cacheKey, response);
    return { status: 200, body: response, usage };
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
