import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadEchoConfig, resolveEchoPaths } from "@echo/config";
import {
  AnswerCheckRequestSchema,
  AskRequestSchema,
  GenerateChecksRequestSchema,
} from "@echo/contracts";
import {
  getSession,
  getSessionSummary,
  getSnapshotByCommit,
  listProjects,
  listSessions,
  listSnapshotFiles,
  listSnapshots,
  openEchoDb,
  readEvents,
} from "@echo/db";
import Fastify from "fastify";
import { createAskService } from "./ask";
import { createChecksService } from "./checks";
import { createEngagementService } from "./engagement";
import { loadLocalEnv } from "./env";
import { createHistoryService } from "./history";
import { createIngest } from "./ingest";
import { createMuseIngest } from "./muse-ingest";
import { createMuseWatcher } from "./muse-watch";
import { buildSessionReview } from "./review-index";
import { readSnapshotFile } from "./snapshot-view";
import { createStoryService } from "./story";

const VERSION = "0.1.0";
const DEFAULT_PORT = 4783;
const HOST = "127.0.0.1";

function resolvePort(): number {
  const raw = process.env.ECHO_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid ECHO_PORT: ${raw}`);
  }
  return port;
}

const startedAt = Date.now();
loadLocalEnv();
const paths = resolveEchoPaths();
mkdirSync(paths.dataDir, { recursive: true });
const db = openEchoDb(join(paths.dataDir, "echo.sqlite"));
const app = Fastify({ logger: true });
const story = createStoryService({ db, dataDir: paths.dataDir, log: app.log });
// Fire-and-forget finalize hook: never awaited (model latency would stall
// polling) and never throws into ingest (errors are logged here).
const storyHook = (sessionId: string): void => {
  void story
    .maybeGenerateStory(sessionId, { reason: "finalize" })
    .catch((error) =>
      app.log.error({ err: String(error), session_id: sessionId }, "story finalize failed"),
    );
};
const ingest = createIngest({
  dataDir: paths.dataDir,
  db,
  log: app.log,
  onSessionQuiescent: storyHook,
});
const config = loadEchoConfig();
const museIngest = createMuseIngest({
  dataDir: paths.dataDir,
  db,
  log: app.log,
  projects: config.projects,
  onSessionQuiescent: storyHook,
});
const ask = createAskService(db, paths.dataDir, { log: app.log });
const checks = createChecksService(db, paths.dataDir);
const engagement = createEngagementService(db);
const history = createHistoryService(db, paths.dataDir);

app.get("/api/health", async () => ({
  status: "ok",
  version: VERSION,
  mode: process.env.ECHO_MODE === "demo" ? "demo" : "local",
  uptimeMs: Date.now() - startedAt,
}));

app.get("/api/projects", async () => listProjects(db));

app.get<{ Params: { id: string } }>("/api/projects/:id/sessions", async (request) =>
  listSessions(db, request.params.id),
);

app.get<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
  const summary = getSessionSummary(db, request.params.id);
  if (!summary) {
    return reply.code(404).send({
      error: { code: "not_found", message: "unknown session" },
    });
  }
  return summary;
});

app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>(
  "/api/sessions/:id/events",
  async (request, reply) => {
    const after = request.query.after === undefined ? 0 : Number(request.query.after);
    const limit = request.query.limit === undefined ? 500 : Number(request.query.limit);
    if (
      !Number.isInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000
    ) {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: "after must be an integer >= 0 and limit an integer in 1..1000",
        },
      });
    }
    return { events: readEvents(db, request.params.id, after, limit) };
  },
);

app.get<{ Params: { id: string } }>("/api/sessions/:id/review", async (request, reply) => {
  try {
    return await buildSessionReview(db, paths.dataDir, request.params.id);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("unknown session")) {
      return reply.code(404).send({
        error: { code: "not_found", message: "unknown session" },
      });
    }
    request.log.error({ err: String(error) }, "session review failed");
    return reply.code(500).send({
      error: { code: "invalid_request", message: "could not build session review" },
    });
  }
});

app.post<{ Params: { id: string } }>("/api/sessions/:id/ask", async (request, reply) => {
  const parsed = AskRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: { code: "invalid_request", message: "question is required (max 2000 chars)" },
    });
  }
  const outcome = await ask.answer(request.params.id, parsed.data);
  return reply.code(outcome.status).send(outcome.body);
});

app.get<{ Params: { id: string } }>("/api/sessions/:id/ask/thread", async (request, reply) => {
  const outcome = await ask.thread(request.params.id);
  return reply.code(outcome.status).send(outcome.body);
});

app.get<{ Params: { id: string } }>("/api/sessions/:id/checks", async (request, reply) => {
  const outcome = await checks.sessionChecks(request.params.id);
  return reply.code(outcome.status).send(outcome.body);
});

app.post<{ Params: { id: string } }>(
  "/api/sessions/:id/checks/generate",
  async (request, reply) => {
    const parsed = GenerateChecksRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "limit 1..5 with opened/waived hunk lists" },
      });
    }
    const outcome = await checks.generate(request.params.id, parsed.data);
    return reply.code(outcome.status).send(outcome.body);
  },
);

app.post<{ Params: { id: string } }>("/api/checks/:id/answer", async (request, reply) => {
  const parsed = AnswerCheckRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: { code: "invalid_request", message: "confidence plus a non-empty answer" },
    });
  }
  const outcome = await checks.answer(request.params.id, parsed.data);
  return reply.code(outcome.status).send(outcome.body);
});

app.post<{ Params: { id: string } }>("/api/sessions/:id/engagement", async (request, reply) => {
  const outcome = engagement.record(request.params.id, request.body);
  return reply.code(outcome.status).send(outcome.body);
});

app.get<{ Params: { id: string }; Querystring: { cardIds?: string } }>(
  "/api/sessions/:id/engagement",
  async (request, reply) => {
    const raw = request.query.cardIds;
    const cardIds =
      raw === undefined || raw === "" ? undefined : raw.split(",").map((part) => part.trim());
    const outcome = engagement.state(request.params.id, cardIds);
    return reply.code(outcome.status).send(outcome.body);
  },
);

app.get<{ Params: { id: string } }>("/api/sessions/:id/history", async (request, reply) => {
  const outcome = history.forSession(request.params.id);
  return reply.code(outcome.status).send(outcome.body);
});

app.get<{ Params: { id: string } }>("/api/sessions/:id/report", async (request, reply) => {
  const outcome = await checks.report(request.params.id);
  return reply.code(outcome.status).send(outcome.body);
});

app.get<{ Params: { id: string } }>("/api/sessions/:id/story", async (request, reply) => {
  // Read-through cache: generates on missing/stale, serves the artifact when
  // the tape watermark still matches.
  const outcome = await story.maybeGenerateStory(request.params.id, { reason: "read-through" });
  if (outcome.outcome === "unknown_session" || !outcome.story) {
    const code = outcome.outcome === "unknown_session" ? 404 : 500;
    const errorCode = outcome.outcome === "unknown_session" ? "not_found" : "redaction_failed";
    const message = outcome.outcome === "unknown_session" ? "unknown session" : "story unavailable";
    return reply.code(code).send({ error: { code: errorCode, message } });
  }
  return outcome.story;
});

app.get<{ Params: { id: string } }>("/api/sessions/:id/snapshots", async (request) =>
  listSnapshots(db, request.params.id).map((row) => ({
    commitOid: row.commitOid,
    trigger: row.trigger,
    eventId: row.eventId,
    takenAt: row.takenAt,
    fileCount: row.fileCount,
    totalBytes: row.totalBytes,
    status: row.status,
    diagnostics: row.diagnostics,
  })),
);

app.get<{ Params: { id: string; commit: string } }>(
  "/api/sessions/:id/snapshots/:commit/files",
  async (request, reply) => {
    const snapshot =
      getSession(db, request.params.id) &&
      getSnapshotByCommit(db, request.params.id, request.params.commit);
    if (!snapshot) {
      return reply.code(404).send({
        error: { code: "not_found", message: "unknown session or snapshot" },
      });
    }
    return listSnapshotFiles(db, snapshot.id);
  },
);

app.get<{ Params: { id: string; commit: string }; Querystring: { path?: string } }>(
  "/api/sessions/:id/snapshots/:commit/blob",
  async (request, reply) => {
    const outcome = await readSnapshotFile(
      db,
      paths.dataDir,
      request.params.id,
      request.params.commit,
      request.query.path ?? "",
    );
    if (!outcome.ok) {
      return reply
        .code(outcome.code === "not_found" ? 404 : 400)
        .send({ error: { code: outcome.code, message: outcome.message } });
    }
    return outcome.content;
  },
);

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  ingest.stop();
  museIngest.stop();
  museWatcher?.stop();
  db.close();
  await app.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

let museWatcher: { start: () => void; stop: () => void } | null = null;

try {
  await app.listen({ host: HOST, port: resolvePort() });
  ingest.start();
  museIngest.start(config.poll_interval_ms);
  // The watcher only shortens poll latency: every event it reports also
  // arrives via the interval, so a dead watcher degrades to polling.
  museWatcher = createMuseWatcher({
    sessionsDir: museIngest.sessionsDir,
    log: app.log,
    onDirty: () => {
      void museIngest
        .runOnce()
        .then((result) => {
          if (result.eventsAdded > 0) {
            app.log.info({ ...result }, "ingested muse sessions (watch)");
          }
        })
        .catch((error) => {
          app.log.error({ err: String(error) }, "muse watch ingest failed");
        });
    },
  });
  museWatcher.start();
  const initial = await ingest.runOnce();
  if (initial.eventsAdded > 0) {
    app.log.info({ ...initial }, "ingested opencode sessions");
  }
  const museInitial = await museIngest.runOnce();
  if (museInitial.eventsAdded > 0) {
    app.log.info({ ...museInitial }, "ingested muse sessions");
  }
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
