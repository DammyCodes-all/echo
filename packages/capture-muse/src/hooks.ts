import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { TapeEventKind } from "@echo/contracts";
import { redactJson } from "@echo/redaction";

export const MUSE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "PreLLMCall",
  "PostLLMCall",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
  "SessionFork",
  "ToolUseStart",
] as const;

export type MuseHookName = (typeof MUSE_HOOK_EVENTS)[number];

const KIND_BY_HOOK: Record<MuseHookName, TapeEventKind> = {
  SessionStart: "session.started",
  UserPromptSubmit: "prompt.submitted",
  PreToolUse: "tool.requested",
  ToolUseStart: "tool.requested",
  PermissionRequest: "approval.requested",
  PostToolUse: "tool.completed",
  PostToolUseFailure: "tool.failed",
  PostToolBatch: "tool.batch",
  PreLLMCall: "model.call",
  PostLLMCall: "model.response",
  PreCompact: "capture.compaction",
  PostCompact: "capture.compaction",
  SubagentStart: "subagent.started",
  SubagentStop: "subagent.stopped",
  Notification: "notification",
  Stop: "turn.ended",
  StopFailure: "turn.failed",
  SessionEnd: "session.ended",
  SessionFork: "session.started",
};

const MAX_PREVIEW_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function resolveHookProject(cwd: string | null, projects: string[]): string | null {
  if (!cwd) return null;
  const normalized = resolve(cwd);
  for (const project of projects) {
    const root = resolve(project);
    // resolve() normalizes separators and trailing slashes, so a prefix
    // check suffices on the supported Linux/macOS targets.
    if (normalized === root || normalized.startsWith(`${root}/`)) return root;
  }
  return null;
}

function boundPreview(payload: unknown): { value: unknown; truncated: boolean } {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload) ?? "null";
  } catch {
    return { value: { unserializable: true }, truncated: true };
  }
  if (Buffer.byteLength(serialized, "utf8") <= MAX_PREVIEW_BYTES)
    return { value: payload, truncated: false };
  const hash = createHash("sha256").update(serialized).digest("hex");
  return {
    value: { truncated: true, bytes: Buffer.byteLength(serialized, "utf8"), sha256: hash },
    truncated: true,
  };
}

export interface HookTranslateInput {
  event: string;
  payload: unknown;
  projects: string[];
}

export interface HookTranslateResult {
  dropped: boolean;
  kind: TapeEventKind | null;
  sessionId: string | null;
  projectRoot: string | null;
  toolName: string | null;
  redactedPayload: unknown;
  findings: number;
  diagnostics: string[];
}

// Pure and fast by design: no I/O, bounded previews, exit-0 caller contract.
// Anything unattributable or unredactable is dropped with a diagnostic.
export function translateMuseHook(input: HookTranslateInput): HookTranslateResult {
  const diagnostics: string[] = [];
  const fail = (diagnostic: string): HookTranslateResult => ({
    dropped: true,
    kind: null,
    sessionId: null,
    projectRoot: null,
    toolName: null,
    redactedPayload: null,
    findings: 0,
    diagnostics: [diagnostic],
  });

  if (!MUSE_HOOK_EVENTS.includes(input.event as MuseHookName)) {
    return fail("unknown_hook_event");
  }
  const kind = KIND_BY_HOOK[input.event as MuseHookName];
  const record = isRecord(input.payload) ? input.payload : {};
  const sessionId = firstString(record, ["session_id", "sessionId"]);
  const cwd = firstString(record, ["cwd", "working_directory", "workingDirectory", "directory"]);
  const toolName = firstString(record, ["tool_name", "toolName", "name"]);
  const projectRoot = resolveHookProject(cwd, input.projects);
  if (!projectRoot) return fail("unattributed_project");

  const { value: preview, truncated } = boundPreview(input.payload);
  if (truncated) diagnostics.push("truncation");
  let redactedPayload: unknown = preview;
  let findings = 0;
  try {
    const redacted = redactJson(preview);
    redactedPayload = redacted.value;
    findings = redacted.findings.length;
  } catch {
    return fail("redaction_failed");
  }
  if (input.event === "SessionFork") diagnostics.push("forked_session");
  return {
    dropped: false,
    kind,
    sessionId,
    projectRoot,
    toolName,
    redactedPayload,
    findings,
    diagnostics,
  };
}
