import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  importOpenCodeSession,
  listOpenCodeSessions,
  projectIdForDirectory,
  readOpenCodeSession,
} from "./index";

const SESSION_ID = "ses_e8311d087ffeekzEFkrr3jS3kl";
const START_OID = "853694aae8816094a0d875fee7ea26278dbf5d0f";
const END_OID = "9a1c74aa0e542c1c9c0f2c3ab5de8d1e3f7a6b21";

function makeStore(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "echo-opencode-"));
  const db = new DatabaseSync(join(dir, "opencode.db"));
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT, agent TEXT,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, data TEXT
    );
  `);
  db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    SESSION_ID,
    "echo-capture-spike",
    "/home/dev-aluminate/dev/echo-spike-scratch",
    '{"id":"gpt-6.1-sol","providerID":"agentrouter"}',
    "build",
    1793097340000,
    1793097400000,
  );

  const insert = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)");
  const add = (id: string, type: string, seq: number, created: number, data: unknown) =>
    insert.run(id, SESSION_ID, type, seq, created, JSON.stringify(data));

  add("msg_user", "user", 5, 1793097341000, {
    text: "Add a line. Export METAROUTER_TOKEN=paste-of-32-chars-xxxxx for testing",
    files: [],
    time: { created: 1793097341000 },
  });
  add("msg_assistant_1", "assistant", 6, 1793097343000, {
    agent: "build",
    model: { id: "gpt-6.1-sol", providerID: "agentrouter", variant: "default" },
    finish: "tool-calls",
    snapshot: { start: START_OID, end: END_OID },
    time: { created: 1793097343000 },
    content: [
      { type: "reasoning", text: "I should read the file first.", native: true },
      {
        type: "tool",
        id: "prt_1",
        name: "read",
        executed: true,
        native: true,
        state: {
          status: "completed",
          input: { path: "/home/dev-aluminate/dev/echo-spike-scratch/README.md" },
          content: [{ type: "text", text: "hello" }],
        },
      },
    ],
  });
  add("msg_system", "system", 8, 1793097342000, {
    text: "context",
    description: "system prompt",
    time: { created: 1793097342000 },
  });
  add("msg_assistant_2", "assistant", 34, 1793097344000, {
    model: { id: "gpt-6.1-sol", providerID: "agentrouter" },
    snapshot: { start: START_OID },
    time: { created: 1793097344000 },
    content: [
      {
        type: "tool",
        id: "prt_2",
        name: "edit",
        state: { status: "error", input: { path: "README.md" }, content: "aborted" },
      },
    ],
  });
  add("msg_assistant_3", "assistant", 61, 1793097350000, {
    model: { id: "gpt-6.1-sol", providerID: "agentrouter" },
    snapshot: { start: END_OID, end: END_OID },
    time: { created: 1793097350000 },
    finish: "error",
    error: { type: "provider.rate-limit", message: "no_capacity", status: 200 },
    content: [],
  });
  add("msg_idle", "idle", 83, 1793097807304, {
    time: { created: 1793097807304 },
    outcome: "failed",
    error: {
      type: "provider.rate-limit",
      message: "no_capacity: demand is high",
      status: 200,
      response: { body: '{"type":"error"}' },
    },
  });
  return db;
}

function importSession(db: DatabaseSync, at = "2026-10-27T09:00:00.000Z") {
  const session = readOpenCodeSession(db, SESSION_ID);
  if (!session) throw new Error("fixture session missing");
  return importOpenCodeSession(db, session, new Date(at));
}

afterEach(() => {
  // temp dirs are left to the OS; stores are closed by each test
});

describe("importOpenCodeSession", () => {
  it("maps the observed session shape into canonical tape events", () => {
    const db = makeStore();
    const result = importSession(db);
    db.close();

    expect(result.projectId).toBe(
      projectIdForDirectory("/home/dev-aluminate/dev/echo-spike-scratch"),
    );
    expect(result.quality).toBe("import_only");
    expect(result.baselineOid).toBe(START_OID);
    expect(result.events.map((event) => event.kind)).toEqual([
      "session.started",
      "prompt.submitted",
      "model.response",
      "tool.completed",
      "notification",
      "model.response",
      "tool.failed",
      "model.response",
      "turn.failed",
    ]);

    const started = result.events[0];
    const startedPayload = started?.payload as { model_label: string };
    expect(startedPayload.model_label).toBe("agentrouter/gpt-6.1-sol");
    expect(started?.record_key).toBe(`opencode:${SESSION_ID}:session`);

    const prompt = result.events[1];
    expect(prompt?.kind).toBe("prompt.submitted");
    expect(JSON.stringify(prompt?.payload)).not.toContain("paste-of-32-chars-xxxxx");
    expect(prompt?.redaction.findings).toBe(1);
    expect(prompt?.record_key).toBe(`opencode:${SESSION_ID}:msg:msg_user`);

    const response = result.events[2];
    expect(response?.links.snapshot).toEqual({
      kind: "git_oids",
      start_oid: START_OID,
      end_oid: END_OID,
    });
    const responsePayload = response?.payload as { parts: Array<{ type: string }> };
    expect(responsePayload.parts.map((part) => part.type)).toEqual(["reasoning"]);

    const tool = result.events[3];
    expect(tool?.links.tool_call_id).toBe("prt_1");
    expect(tool?.source.sequence).toBe(6);
    expect(tool?.record_key).toBe(`opencode:${SESSION_ID}:msg:msg_assistant_1:tool:prt_1`);

    const killed = result.events[6];
    expect(killed?.kind).toBe("tool.failed");
    expect(killed?.links.snapshot).toEqual({
      kind: "git_oids",
      start_oid: START_OID,
      end_oid: null,
    });

    const finishError = result.events[7]?.payload as {
      error: { type: string; message: string };
    };
    expect(finishError.error).toEqual({
      type: "provider.rate-limit",
      message: "no_capacity",
      status: 200,
    });

    const turnFailed = result.events[8];
    expect(turnFailed?.kind).toBe("turn.failed");
    const idlePayload = turnFailed?.payload as {
      outcome: string;
      error: { type: string; message: string; status: number };
    };
    expect(idlePayload.outcome).toBe("failed");
    expect(idlePayload.error.type).toBe("provider.rate-limit");
    expect(idlePayload.error.status).toBe(200);
    expect(JSON.stringify(turnFailed?.payload)).not.toContain("response");
  });

  it("keeps event ids stable for unchanged records and revises changed ones", () => {
    const db = makeStore();
    const first = importSession(db);

    const changed = JSON.parse(
      String(
        (
          db.prepare("SELECT data FROM session_message WHERE id = ?").get("msg_assistant_1") as {
            data: string;
          }
        ).data,
      ),
    ) as { content: Array<Record<string, unknown>> };
    const reasoning = changed.content[0] as { text: string };
    reasoning.text = "I should read the README first.";
    db.prepare("UPDATE session_message SET data = ? WHERE id = ?").run(
      JSON.stringify(changed),
      "msg_assistant_1",
    );

    const second = importSession(db, "2026-10-27T09:05:00.000Z");
    db.close();

    expect(second.events).toHaveLength(first.events.length);
    const firstById = new Map(first.events.map((event) => [event.record_key, event.event_id]));
    const secondById = new Map(second.events.map((event) => [event.record_key, event.event_id]));
    expect(secondById.get(`opencode:${SESSION_ID}:msg:msg_assistant_1`)).not.toBe(
      firstById.get(`opencode:${SESSION_ID}:msg:msg_assistant_1`),
    );
    expect(secondById.get(`opencode:${SESSION_ID}:msg:msg_user`)).toBe(
      firstById.get(`opencode:${SESSION_ID}:msg:msg_user`),
    );
    expect(secondById.get(`opencode:${SESSION_ID}:msg:msg_assistant_1:tool:prt_1`)).toBe(
      firstById.get(`opencode:${SESSION_ID}:msg:msg_assistant_1:tool:prt_1`),
    );
  });

  it("records skipped source rows as gaps and pending tools as requests", () => {
    const db = makeStore();
    const insert = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)");
    insert.run("msg_bad", SESSION_ID, "user", 85, 1793097810000, "{not json");
    insert.run(
      "msg_running",
      SESSION_ID,
      "assistant",
      87,
      1793097811000,
      JSON.stringify({
        time: { created: 1793097811000 },
        snapshot: { start: END_OID },
        content: [
          {
            type: "tool",
            id: "prt_3",
            name: "edit",
            state: { status: "running", input: { path: "README.md" } },
          },
        ],
      }),
    );

    const result = importSession(db);
    db.close();

    expect(result.quality).toBe("partial");
    const gap = result.events.find((event) => event.kind === "capture.gap");
    expect(gap?.record_key).toBe(`opencode:${SESSION_ID}:msg:msg_bad`);
    expect(gap?.payload).toMatchObject({
      code: "schema_drift",
      record_id: "msg_bad",
      detail: "invalid_json",
    });
    expect(gap?.diagnostics).toContain("skipped_source_record");

    const pending = result.events.find((event) => event.links.tool_call_id === "prt_3");
    expect(pending?.kind).toBe("tool.requested");
    expect(pending?.diagnostics).toContain("tool_pending");
  });

  it("lists sessions with their directory for project matching", () => {
    const db = makeStore();
    const sessions = listOpenCodeSessions(db);
    db.close();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.directory).toBe("/home/dev-aluminate/dev/echo-spike-scratch");
  });
});
