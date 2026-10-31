import { createHash } from "node:crypto";
import type { TapeEvent } from "@echo/contracts";
import { expandTerms, openFts } from "./fts";

export type EvidenceKind = "observed" | "agent_stated" | "snapshot" | "diagnostic";
export type EvidenceLabel = "observed" | "agent_stated" | "uncertain";

export interface EvidenceItem {
  evidenceId: string;
  eventId: string;
  kind: EvidenceKind;
  label: EvidenceLabel;
  ts: string;
  text: string;
  filePath: string | null;
}

export interface RetrievalQuery {
  question: string;
  filePath?: string;
  symbols?: string[];
}

export interface EvidenceBundle {
  items: EvidenceItem[];
  bundleHash: string;
  searchedScope: { eventCount: number; filePath: string | null };
}

export type RefusalReason =
  | "not_on_tape"
  | "insufficient_evidence"
  | "ambiguous_question"
  | "model_error";

export interface AnswerClaim {
  text: string;
  evidenceIds: string[];
  quote: string | null;
}

export interface StructuredAnswer {
  refusal: boolean;
  refusalReason: RefusalReason | null;
  answer: string;
  claims: AnswerClaim[];
  uncertainty: "low" | "medium" | "high";
}

export interface ValidationResult {
  status: "answered" | "partial" | "refused";
  validClaims: Array<AnswerClaim & { weak: boolean }>;
  invalidClaims: Array<{ claim: AnswerClaim; reason: string }>;
  refusalReason: RefusalReason | null;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "what",
  "why",
  "how",
  "did",
  "was",
  "were",
  "with",
  "from",
  "that",
  "this",
  "when",
  "where",
  "which",
  "about",
  "into",
  "does",
  "are",
  "didn",
  "have",
  "has",
  "had",
  "been",
  "you",
  "your",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function payloadText(kind: string, payload: unknown): string {
  if (payload === null || payload === undefined) return kind;
  if (typeof payload === "string") return `${kind}: ${payload}`.slice(0, 300);
  if (typeof payload !== "object") return `${kind}: ${String(payload)}`.slice(0, 300);
  const record = payload as Record<string, unknown>;
  const input = record.input as Record<string, unknown> | undefined;
  const error = record.error as Record<string, unknown> | undefined;
  const name = typeof record.name === "string" ? record.name : null;
  const outcome = typeof record.outcome === "string" ? record.outcome : null;
  if (typeof record.text === "string") return `prompt: ${record.text}`.slice(0, 300);
  // Model responses carry agent-stated text under varying keys.
  if (kind === "model.response") {
    const said =
      typeof record.content === "string"
        ? record.content
        : typeof record.summary === "string"
          ? record.summary
          : null;
    if (said !== null) return `agent said: ${said}`.slice(0, 300);
  }
  // Muse native payloads nest readable content under `event`: tool calls
  // carry names + JSON args, model/task output carries text chunks. Tool
  // result batches are split into one summary per result before this runs
  // (see splitMuseResults), so a long first result cannot crowd the rest
  // out of the 300-char window. Without this the generic fallback shows
  // envelope noise and the model refuses for lack of usable evidence.
  const nested = record.event;
  if (nested !== null && typeof nested === "object") {
    const event = nested as Record<string, unknown>;
    if (Array.isArray(event.tool_calls)) {
      const calls: string[] = [];
      for (const call of event.tool_calls) {
        if (call === null || typeof call !== "object") continue;
        const entry = call as Record<string, unknown>;
        const name = typeof entry.name === "string" ? entry.name : "tool";
        calls.push(`${name}${museCallTarget(entry)}`);
      }
      if (calls.length > 0) return `tool calls: ${calls.join("; ")}`.slice(0, 300);
    }
    if (typeof event.chunk === "string" && event.chunk.length > 0) {
      const prefix = kind === "model.response" ? "agent said" : "output";
      return `${prefix}: ${summarizeMuseText(event.chunk)}`
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MUSE_SUMMARY_CHARS);
    }
  }
  if (name !== null) {
    const target =
      input !== undefined && typeof input.path === "string"
        ? input.path
        : input !== undefined && typeof input.command === "string"
          ? input.command
          : "";
    const detail =
      error !== undefined && typeof error.detail === "string"
        ? ` ${error.detail}`
        : error !== undefined && typeof error.type === "string"
          ? ` ${error.type}`
          : "";
    // Exit codes decide exec questions; the generic template used to drop them.
    const exit =
      typeof record.exitCode === "number" || typeof record.exit_code === "number"
        ? ` exit ${record.exitCode ?? record.exit_code}`
        : "";
    const content = typeof record.content === "string" ? ` ${record.content}`.slice(0, 120) : "";
    return `tool ${name} ${outcome ?? "requested"} ${target}${exit}${detail}${content}`
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
  }
  if (typeof record.trigger === "string") {
    const commit =
      typeof record.commit_oid === "string" && record.commit_oid.length > 0
        ? ` ${record.commit_oid.slice(0, 8)}`
        : "";
    return `snapshot ${record.trigger}${commit}`.slice(0, 200);
  }
  if (typeof record.task === "string" || typeof record.subagent_id === "string") {
    const id = typeof record.subagent_id === "string" ? record.subagent_id : "";
    const what = typeof record.task === "string" ? record.task : (outcome ?? kind);
    return `subagent ${id} ${what}`.replace(/\s+/g, " ").trim().slice(0, 200);
  }
  if (kind === "capture.gap") {
    const code =
      typeof record.code === "string" ? record.code : JSON.stringify(record).slice(0, 160);
    return `capture gap: ${code}`.slice(0, 200);
  }
  if (typeof record.outcome === "string") return `${kind}: ${record.outcome}`.slice(0, 200);
  return `${kind}: ${JSON.stringify(record).slice(0, 200)}`;
}

// Muse tool-call args are a JSON string; pull the path/command/file out with
// patterns instead of parsing so malformed args degrade to no target.
function museCallTarget(call: Record<string, unknown>): string {
  const args = call.args;
  if (typeof args !== "string") return "";
  for (const key of ["path", "command", "file", "pattern"]) {
    const match = args.match(new RegExp(`"${key}"\\s*:\\s*"([^"]{1,80})"`));
    if (match?.[1] !== undefined) return ` ${match[1]}`;
  }
  return "";
}

// Muse summaries get a wider window than the 300-char opencode shapes:
// tool outputs lead with progress lines and put the decisive detail
// (assertion diffs, failure sections) hundreds of chars in. Eight items at
// this width still sit far under the 48k bundle budget.
const MUSE_SUMMARY_CHARS = 800;

// Muse exec results wrap command output in a JSON envelope; the output is
// what answers questions, so it leads and the envelope compresses to a
// command + exit prefix. Anything that is not an exec envelope passes
// through untouched.
function summarizeMuseText(text: string): string {
  if (!text.startsWith("{")) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (parsed === null || typeof parsed !== "object") return text;
  const record = parsed as Record<string, unknown>;
  if (typeof record.command !== "string" || typeof record.output !== "string") return text;
  const exit = record.exit_code ?? record.exitCode;
  const head = `exec ${record.command} exit ${typeof exit === "number" ? exit : "?"}`.trim();
  return record.output.length > 0 ? `${head}: ${record.output}` : head;
}

// One summary per tool result, or null when the event is not a Muse batch
// with readable result text (the normal single-summary path then applies).
function splitMuseResults(event: TapeEvent): string[] | null {
  if (event.payload === null || typeof event.payload !== "object") return null;
  const nested = (event.payload as Record<string, unknown>).event;
  if (nested === null || typeof nested !== "object") return null;
  const results = (nested as Record<string, unknown>).results;
  if (!Array.isArray(results)) return null;
  const summaries: string[] = [];
  for (const result of results) {
    if (result !== null && typeof result === "object") {
      const text = (result as Record<string, unknown>).text;
      if (typeof text === "string" && text.length > 0) {
        summaries.push(
          `tool result: ${summarizeMuseText(text)}`
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, MUSE_SUMMARY_CHARS),
        );
      }
    }
  }
  return summaries.length > 0 ? summaries : null;
}

// Muse lifecycle envelopes (proposed/intent/completed ids) and skill-catalog
// echoes summarize to id soup or harness chatter, not session evidence.
// Penalized, never excluded: heavy term overlap can still admit them.
function isMuseLifecycleNoise(payload: unknown, summary: string): boolean {
  if (summary.includes("<read-skill-result")) return true;
  if (payload === null || typeof payload !== "object") return false;
  const nested = (payload as Record<string, unknown>).event;
  if (nested === null || typeof nested !== "object") return false;
  const inner = nested as Record<string, unknown>;
  const kind = inner.kind;
  if (kind === "proposed" || kind === "side_effect_intent" || kind === "model_response_created") {
    return true;
  }
  if (kind === "rejected" || kind === "cancelled") return true;
  // Task-completed envelopes are bare ids; result batches share the outer
  // kind but carry results and must never be penalized.
  return kind === "completed" && !Array.isArray(inner.results);
}

function eventFilePath(kind: string, payload: unknown, summary: string): string | null {
  if (payload !== null && typeof payload === "object") {
    const input = (payload as Record<string, unknown>).input;
    if (input !== null && typeof input === "object") {
      const path = (input as Record<string, unknown>).path;
      if (typeof path === "string" && path.length > 0) return path;
    }
  }
  const match = summary.match(/[\w./-]+\.(?:ts|js|tsx|jsx|json|txt|env|example)\b/);
  if (match !== null) {
    // ".env.example" reads carry the example path; the secret policy cares about ".env".
    if (match[0].endsWith(".example")) return match[0].slice(0, -".example".length);
    return match[0];
  }
  void kind;
  return null;
}

function eventKind(kind: string): { kind: EvidenceKind; label: EvidenceLabel; weight: number } {
  switch (kind) {
    case "tool.completed":
    case "tool.failed":
      return { kind: "observed", label: "observed", weight: 2 };
    case "tool.requested":
    case "file.snapshot":
      return {
        kind: kind === "file.snapshot" ? "snapshot" : "observed",
        label: "observed",
        weight: 2,
      };
    case "prompt.submitted":
    case "model.response":
      return { kind: "agent_stated", label: "agent_stated", weight: 1 };
    case "capture.gap":
      return { kind: "diagnostic", label: "uncertain", weight: -2 };
    case "session.started":
    case "session.ended":
    case "turn.ended":
    case "turn.failed":
      return { kind: "observed", label: "observed", weight: -1 };
    default:
      return { kind: "observed", label: "observed", weight: 0 };
  }
}

const TRY_WORDS = new Set([
  "try",
  "tried",
  "first",
  "before",
  "instead",
  "earlier",
  "originally",
  "attempt",
  "attempts",
  "attempted",
  "revert",
  "reverted",
  "abandon",
  "abandoned",
]);

// Change-questions must find edit evidence: "what changed" shares no terms
// with "edit_file src/ledger.js", so the verbs expand to tool vocabulary.
const CHANGE_WORDS = new Set([
  "change",
  "changed",
  "changes",
  "changing",
  "modify",
  "modified",
  "update",
  "updated",
]);
const CHANGE_SYNONYMS = ["edit", "write"];
const DELETE_WORDS = new Set(["delete", "deleted", "remove", "removed"]);
const DELETE_SYNONYMS = ["rm"];

/**
 * Retrieval over redacted tape events, FTS5-backed since the hackathon
 * build (porter stemmer, prefix terms). The scoring contract is unchanged
 * (file match + term overlap + kind weight, tape_seq tiebreak): the upgrade
 * changes recall — stemming and prefix find candidates word overlap
 * missed — not the answer shape.
 *
 * Two refinements over plain matching: try-first questions boost
 * superseded writes (a write the tape later overwrote is a reverted
 * attempt), and the bundle fills best-first within a character budget
 * (~4 chars per token) so one giant event cannot crowd out small decisive
 * ones. The top hit always survives, so a tiny budget degrades to one item
 * instead of a refusal.
 */
export function buildEvidenceBundle(
  events: TapeEvent[],
  query: RetrievalQuery,
  options: { maxItems?: number; maxChars?: number } = {},
): EvidenceBundle {
  const maxItems = options.maxItems ?? 8;
  const maxChars = options.maxChars ?? 48_000;
  const questionTokens = new Set(tokenize(query.question));
  for (const symbol of query.symbols ?? []) {
    for (const token of tokenize(symbol)) questionTokens.add(token);
  }
  if ([...questionTokens].some((token) => CHANGE_WORDS.has(token))) {
    for (const synonym of CHANGE_SYNONYMS) questionTokens.add(synonym);
  }
  if ([...questionTokens].some((token) => DELETE_WORDS.has(token))) {
    for (const synonym of DELETE_SYNONYMS) questionTokens.add(synonym);
  }
  const queryFile = query.filePath ?? null;

  // A write this tape later overwrote is a reverted attempt: last write per
  // path wins, everything before it attempted. Only try-first questions
  // spend the bonus, so ordinary questions keep their ranking.
  const writesByPath = new Map<string, string[]>();
  for (const event of events) {
    if (event.kind !== "tool.requested") continue;
    if (event.payload === null || typeof event.payload !== "object") continue;
    const record = event.payload as Record<string, unknown>;
    if (record.name !== "write") continue;
    const input = record.input as Record<string, unknown> | undefined;
    const path = input !== undefined && typeof input.path === "string" ? input.path : null;
    if (path === null) continue;
    const seen = writesByPath.get(path) ?? [];
    seen.push(event.event_id);
    writesByPath.set(path, seen);
  }
  const superseded = new Set<string>();
  for (const ids of writesByPath.values()) {
    for (const id of ids.slice(0, -1)) superseded.add(id);
  }
  const wantsAttempts = tokenize(query.question).some((token) => TRY_WORDS.has(token));

  const scored: Array<{ item: EvidenceItem; score: number; seq: number; relevant: boolean }> = [];
  // A Muse tool-result batch holds several tool outputs in one event; each
  // result becomes its own unit so every output ranks and displays on its
  // own instead of sharing one 300-char window.
  const units: Array<{ event: TapeEvent; summary: string; filePath: string | null }> = [];
  for (const event of events) {
    const split = event.diagnostics.length === 0 ? splitMuseResults(event) : null;
    if (split === null) {
      const summary = payloadText(event.kind, event.payload);
      // Scope is a ranking boost (fileMatched), never a relabel: stamping every
      // doc with the query file makes fileMatched true tape-wide, which admits
      // unrelated events and breaks pre-model refusal for scoped questions.
      const filePath = eventFilePath(event.kind, event.payload, summary);
      units.push({ event, summary, filePath });
    } else {
      for (const summary of split) {
        units.push({ event, summary, filePath: eventFilePath(event.kind, event.payload, summary) });
      }
    }
  }
  const documents = units.map((unit) => ({
    summary: unit.summary,
    filePath: unit.filePath,
    text: `${unit.summary} ${unit.filePath ?? ""}`,
  }));
  const terms = expandTerms(questionTokens);
  const fts = openFts(documents.map((doc) => doc.text));
  try {
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const doc = documents[i];
      if (unit === undefined || doc === undefined) continue;
      const { event } = unit;
      const { summary, filePath } = doc;
      const mapped = eventKind(event.kind);
      const overlap = fts.overlap(i, terms);
      let score = overlap + mapped.weight;
      if (isMuseLifecycleNoise(event.payload, summary)) score -= 4;
      const fileMatched = queryFile !== null && filePath === queryFile;
      if (fileMatched) score += 3;
      if (wantsAttempts && superseded.has(event.event_id)) score += 2;
      // Kind weight ranks; only term overlap or an explicit file match admits.
      // Otherwise a tool-heavy tape answers "what is the capital of France?".
      const relevant = overlap > 0 || fileMatched;
      if (event.diagnostics.length > 0) {
        const diagnostic = `diagnostic: ${event.diagnostics.join("; ")}`.slice(0, 200);
        scored.push({
          item: {
            evidenceId: "",
            eventId: event.event_id,
            kind: "diagnostic",
            label: "uncertain",
            ts: event.ts,
            text: `${summary} — ${diagnostic}`,
            filePath,
          },
          score: score - 1,
          seq: event.tape_seq,
          relevant,
        });
        continue;
      }
      scored.push({
        item: {
          evidenceId: "",
          eventId: event.event_id,
          kind: mapped.kind,
          label: mapped.label,
          ts: event.ts,
          text: summary,
          filePath,
        },
        score,
        seq: event.tape_seq,
        relevant,
      });
    }
  } finally {
    fts.close();
  }

  const ranked = scored
    .filter((entry) => entry.relevant && entry.score > 0)
    .sort((a, b) => b.score - a.score || a.seq - b.seq);
  const picked: typeof scored = [];
  let used = 0;
  for (const entry of ranked) {
    if (picked.length >= Math.max(0, maxItems)) break;
    if (picked.length > 0 && used + entry.item.text.length > maxChars) break;
    picked.push(entry);
    used += entry.item.text.length;
  }

  const items = picked.map((entry, index) => ({ ...entry.item, evidenceId: `E${index + 1}` }));
  const bundleHash = createHash("sha256")
    .update(items.map((item) => `${item.evidenceId}:${item.eventId}:${item.text}`).join("\n"))
    .digest("hex")
    .slice(0, 16);
  return {
    items,
    bundleHash,
    searchedScope: { eventCount: events.length, filePath: queryFile },
  };
}

/** Pre-model refusal: nothing above the relevance threshold. */
export function shouldRefuseBeforeModel(bundle: EvidenceBundle): RefusalReason | null {
  return bundle.items.length === 0 ? "not_on_tape" : null;
}

export function refusalAnswer(reason: RefusalReason): StructuredAnswer {
  return { refusal: true, refusalReason: reason, answer: "", claims: [], uncertainty: "low" };
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Boundary parse for model output: the model is untrusted input, so shape
 * failures here become model_error refusals, never exceptions upstream.
 */
export function parseAnswer(value: unknown): StructuredAnswer | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.refusal !== "boolean") return null;
  if (typeof record.answer !== "string") return null;
  if (!Array.isArray(record.claims)) return null;
  if (
    record.uncertainty !== "low" &&
    record.uncertainty !== "medium" &&
    record.uncertainty !== "high"
  ) {
    return null;
  }
  const refusalReason = record.refusalReason ?? record.refusal_reason ?? null;
  if (
    refusalReason !== null &&
    refusalReason !== "not_on_tape" &&
    refusalReason !== "insufficient_evidence" &&
    refusalReason !== "ambiguous_question" &&
    refusalReason !== "model_error"
  ) {
    return null;
  }
  const claims: AnswerClaim[] = [];
  for (const entry of record.claims) {
    if (entry === null || typeof entry !== "object") return null;
    const claim = entry as Record<string, unknown>;
    if (typeof claim.text !== "string") return null;
    if (!Array.isArray(claim.evidenceIds) && !Array.isArray(claim.evidence_ids)) return null;
    const ids = (claim.evidenceIds ?? claim.evidence_ids) as unknown[];
    if (!ids.every((id) => typeof id === "string")) return null;
    const quote = claim.quote ?? null;
    if (quote !== null && typeof quote !== "string") return null;
    claims.push({ text: claim.text, evidenceIds: ids as string[], quote });
  }
  return {
    refusal: record.refusal,
    refusalReason: refusalReason as RefusalReason | null,
    answer: record.answer,
    claims,
    uncertainty: record.uncertainty,
  };
}

/**
 * The server, not the model, decides whether a citation is valid
 * (ARCHITECTURE §14): every evidence_id must exist in the bundle and every
 * quote must occur verbatim (whitespace-collapsed) in cited evidence text.
 * Quoteless claims survive only as weak restatements, never as proof.
 */
export function validateCitations(
  bundle: EvidenceBundle,
  answer: StructuredAnswer,
): ValidationResult {
  if (answer.refusal) {
    return {
      status: "refused",
      validClaims: [],
      invalidClaims: [],
      refusalReason: answer.refusalReason ?? "not_on_tape",
    };
  }
  const byId = new Map(bundle.items.map((item) => [item.evidenceId, item]));
  const validClaims: Array<AnswerClaim & { weak: boolean }> = [];
  const invalidClaims: Array<{ claim: AnswerClaim; reason: string }> = [];
  for (const claim of answer.claims) {
    if (claim.evidenceIds.length === 0) {
      invalidClaims.push({ claim, reason: "claim cites no evidence" });
      continue;
    }
    const unknown = claim.evidenceIds.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      invalidClaims.push({ claim, reason: `unknown evidence_id: ${unknown.join(", ")}` });
      continue;
    }
    if (claim.quote === null) {
      validClaims.push({ ...claim, weak: true });
      continue;
    }
    const want = normalizeWhitespace(claim.quote);
    if (want.length === 0) {
      invalidClaims.push({ claim, reason: "empty quote" });
      continue;
    }
    const supported = claim.evidenceIds.some((id) => {
      const item = byId.get(id);
      return item !== undefined && normalizeWhitespace(item.text).includes(want);
    });
    if (!supported) {
      invalidClaims.push({ claim, reason: "quote not found in cited evidence" });
      continue;
    }
    validClaims.push({ ...claim, weak: false });
  }
  if (validClaims.length === 0) {
    return {
      status: "refused",
      validClaims,
      invalidClaims,
      refusalReason: "insufficient_evidence",
    };
  }
  if (invalidClaims.length > 0) {
    return { status: "partial", validClaims, invalidClaims, refusalReason: null };
  }
  return { status: "answered", validClaims, invalidClaims, refusalReason: null };
}
