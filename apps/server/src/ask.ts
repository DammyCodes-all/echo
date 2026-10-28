import { createHash } from "node:crypto";
import {
  type AskRequest,
  type AskResponse,
  type TapeEvent,
  TapeEventKindSchema,
} from "@echo/contracts";
import { type EchoDb, getSession, readAllEvents, type StoredEvent } from "@echo/db";
import { type ModelConfig, ModelError, modelConfigFromEnv, requestJson } from "@echo/model";
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

interface AskServiceOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
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

function storedToTape(sessionId: string, projectId: string, stored: StoredEvent): TapeEvent | null {
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
 * (nothing relevant on the tape) never reach the model.
 */
export function createAskService(db: EchoDb, options: AskServiceOptions = {}) {
  const cache = new Map<string, AskResponse>();
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;

  function modelOff(): boolean {
    return env.ECHO_MODEL === "off";
  }

  function resolveConfig(): ModelConfig {
    return modelConfigFromEnv(env);
  }

  async function answer(sessionId: string, input: AskRequest): Promise<AskOutcome> {
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
    const bundle = buildEvidenceBundle(events, {
      question: input.question,
      ...(input.filePath ? { filePath: input.filePath } : {}),
      symbols: input.symbols,
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
      return { status: 200, body: refused };
    }

    const cacheKey = createHash("sha256")
      .update(
        `${input.question}\n${bundle.bundleHash}\n${env.META_MODEL_ID ?? "muse-spark-1.3-contributor"}`,
      )
      .digest("hex");
    const hit = cache.get(cacheKey);
    if (hit) return { status: 200, body: { ...hit, cached: true } };
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
    cache.set(cacheKey, response);
    return { status: 200, body: response };
  }

  return { answer };
}
