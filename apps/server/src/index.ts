import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadEchoConfig, resolveEchoPaths } from "@echo/config";
import {
  AskRequestSchema,
  CheckMeRequestSchema,
  CheckV2AnswerRequestSchema,
} from "@echo/contracts";
import {
  getProject,
  getSession,
  getSessionSummary,
  getSnapshotByCommit,
  listProjects,
  listProjectTouchedFiles,
  listSessions,
  listSnapshotFiles,
  listSnapshots,
  openEchoDb,
  readEvents,
} from "@echo/db";
import Fastify, { type FastifyReply } from "fastify";
import { createAskService } from "./ask";
import { createChecksV2Service } from "./checks-v2";
import { createCodeIndexService } from "./code-index";
import { ensureEnabledProjects } from "./enabled-projects";
import { createEngagementService } from "./engagement";
import { loadLocalEnv } from "./env";
import { createHistoryService } from "./history";
import { createIngest } from "./ingest";
import { createLearnService } from "./learn";
import { createMuseIngest } from "./muse-ingest";
import { createMuseWatcher } from "./muse-watch";
import { createProjectTechStackService } from "./project-tech-stack";
import { buildSessionReview } from "./review-index";
import { readSnapshotFile } from "./snapshot-view";
import { createStoryService, filterEmptySessions, isSessionQuiet } from "./story";

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
const checksV2 = createChecksV2Service({ db, dataDir: paths.dataDir, log: app.log });
const engagement = createEngagementService(db);
const history = createHistoryService(db, paths.dataDir);
const codeIndex = createCodeIndexService({ db });
const learn = createLearnService({ db, dataDir: paths.dataDir });
const techStack = createProjectTechStackService(
  { db, dataDir: paths.dataDir, log: app.log },
  {
    ensureIndex: (projectId) => {
      codeIndex.reindex(projectId);
    },
  },
);

app.get("/api/health", async () => ({
  status: "ok",
  version: VERSION,
  mode: process.env.ECHO_MODE === "demo" ? "demo" : "local",
  uptimeMs: Date.now() - startedAt,
}));

app.get("/api/projects", async () => listProjects(db));

app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
  const project = getProject(db, request.params.id);
  if (!project) {
    return reply.code(404).send({
      error: { code: "not_found", message: "unknown project" },
    });
  }
  return project;
});

app.get<{ Params: { id: string } }>("/api/projects/:id/sessions", async (request) => {
  // Content-free skeletons never reach the UI, and neither do sessions that
  // haven't gone quiet yet; recording sessions and unreadable artifacts stay
  // visible. lastActivity is the tape's latest event (or the session touch).
  const nowMs = Date.now();
  return filterEmptySessions(db, listSessions(db, request.params.id)).filter((session) =>
    isSessionQuiet(session.lastActivity, nowMs),
  );
});

app.get<{ Params: { id: string } }>("/api/projects/:id/learn", async (request, reply) => {
  const outcome = learn.summary(request.params.id);
  return reply.code(outcome.status).send(outcome.body);
});

app.get<{ Params: { id: string } }>("/api/projects/:id/files", async (request, reply) => {
  const project = getProject(db, request.params.id);
  if (!project) {
    return reply.code(404).send({
      error: { code: "not_found", message: "unknown project" },
    });
  }
  const { files, truncated } = listProjectTouchedFiles(db, request.params.id);
  return { projectId: project.id, files, truncated };
});

app.get<{ Params: { id: string } }>("/api/projects/:id/tech-stack", async (request, reply) => {
  // Read-through cache: generates on missing/stale, serves the artifact when
  // the code-index watermark still matches. A moved watermark serves the
  // previous artifact as stale while regen is change-gated in the background.
  const outcome = await techStack.maybeGetTechStack(request.params.id);
  if (outcome.outcome === "unknown_project" || !outcome.stack) {
    const code = outcome.outcome === "index_missing" ? 503 : 500;
    const errorCode =
      outcome.outcome === "index_missing" ? "code_index_missing" : "stack_unavailable";
    const message =
      outcome.outcome === "unknown_project"
        ? "unknown project"
        : outcome.outcome === "index_missing"
          ? "code index not ready"
          : "tech stack unavailable";
    return reply.code(outcome.outcome === "unknown_project" ? 404 : code).send({
      error: { code: errorCode, message },
    });
  }
  return outcome.stack;
});

function codeIndexError(reply: FastifyReply) {
  return reply.code(422).send({
    error: { code: "invalid_request", message: "project root unreadable" },
  });
}

app.get<{ Params: { id: string } }>("/api/projects/:id/code", async (request, reply) => {
  try {
    const state = codeIndex.state(request.params.id);
    if (!state) {
      return reply.code(404).send({
        error: { code: "not_found", message: "unknown project" },
      });
    }
    return state;
  } catch (error) {
    if (error instanceof Error && error.message === "code_index_root_unreadable") {
      return codeIndexError(reply);
    }
    throw error;
  }
});

app.post<{ Params: { id: string } }>("/api/projects/:id/code/reindex", async (request, reply) => {
  try {
    const result = codeIndex.reindex(request.params.id, { force: true });
    if (!result) {
      return reply.code(404).send({
        error: { code: "not_found", message: "unknown project" },
      });
    }
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === "code_index_root_unreadable") {
      return codeIndexError(reply);
    }
    throw error;
  }
});

app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
  "/api/projects/:id/code/files",
  async (request, reply) => {
    try {
      const result = codeIndex.files(request.params.id, Number(request.query.limit));
      if (!result) {
        return reply.code(404).send({
          error: { code: "not_found", message: "unknown project" },
        });
      }
      return { projectId: request.params.id, ...result };
    } catch (error) {
      if (error instanceof Error && error.message === "code_index_root_unreadable") {
        return codeIndexError(reply);
      }
      throw error;
    }
  },
);

app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: string } }>(
  "/api/projects/:id/code/symbols",
  async (request, reply) => {
    try {
      const result = codeIndex.symbols(
        request.params.id,
        request.query.q ?? "",
        Number(request.query.limit),
      );
      if (!result) {
        return reply.code(404).send({
          error: { code: "not_found", message: "unknown project" },
        });
      }
      return { projectId: request.params.id, query: request.query.q ?? "", ...result };
    } catch (error) {
      if (error instanceof Error && error.message === "code_index_root_unreadable") {
        return codeIndexError(reply);
      }
      throw error;
    }
  },
);

app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
  "/api/projects/:id/code/file",
  async (request, reply) => {
    if (!request.query.path) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "path is required" },
      });
    }
    try {
      const detail = codeIndex.fileDetail(request.params.id, request.query.path);
      if (!detail) {
        return reply.code(404).send({
          error: { code: "not_found", message: "unknown project or file" },
        });
      }
      return detail;
    } catch (error) {
      if (error instanceof Error && error.message === "code_index_root_unreadable") {
        return codeIndexError(reply);
      }
      throw error;
    }
  },
);

app.get<{ Params: { id: string }; Querystring: { root?: string; depth?: string; limit?: string } }>(
  "/api/projects/:id/code/graph",
  async (request, reply) => {
    if (!request.query.root) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "root is required" },
      });
    }
    try {
      const graph = codeIndex.graph(
        request.params.id,
        request.query.root,
        Number(request.query.depth),
        Number(request.query.limit),
      );
      if (!graph) {
        return reply.code(404).send({
          error: { code: "not_found", message: "unknown project or file" },
        });
      }
      return graph;
    } catch (error) {
      if (error instanceof Error && error.message === "code_index_root_unreadable") {
        return codeIndexError(reply);
      }
      throw error;
    }
  },
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

app.post<{ Params: { id: string } }>(
  "/api/sessions/:id/checks-v2/generate",
  async (request, reply) => {
    const outcome = await checksV2.generate(request.params.id);
    return reply.code(outcome.status).send(outcome.body);
  },
);

app.get<{ Params: { id: string } }>("/api/sessions/:id/checks-v2", async (request, reply) => {
  const outcome = checksV2.state(request.params.id);
  return reply.code(outcome.status).send(outcome.body);
});

app.post<{ Params: { id: string } }>(
  "/api/sessions/:id/checks-v2/check-me",
  async (request, reply) => {
    const parsed = CheckMeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "cardId is required" },
      });
    }
    const outcome = await checksV2.checkMe(request.params.id, parsed.data.cardId);
    return reply.code(outcome.status).send(outcome.body);
  },
);

app.post<{ Params: { id: string } }>(
  "/api/sessions/:id/checks-v2/answer",
  async (request, reply) => {
    const parsed = CheckV2AnswerRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "questionId and confidence are required" },
      });
    }
    const outcome = await checksV2.answer(request.params.id, parsed.data);
    return reply.code(outcome.status).send(outcome.body);
  },
);

app.post<{ Params: { id: string } }>("/api/sessions/:id/checks-v2/skip", async (request, reply) => {
  const outcome = checksV2.skip(request.params.id);
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

app.get<{ Params: { id: string } }>("/api/sessions/:id/story", async (request, reply) => {
  // Read-through cache: generates on missing/stale, serves the artifact when
  // the tape watermark still matches. A session that went quiet less than a
  // minute ago reports waiting instead of narrating half-finished work.
  const outcome = await story.maybeGenerateStory(request.params.id, { reason: "read-through" });
  if (outcome.outcome === "unknown_session") {
    return reply.code(404).send({ error: { code: "not_found", message: "unknown session" } });
  }
  if (outcome.outcome === "waiting" && !outcome.story) {
    return reply.code(202).send({ waiting: true, sessionId: request.params.id });
  }
  if (!outcome.story) {
    return reply
      .code(500)
      .send({ error: { code: "redaction_failed", message: "story unavailable" } });
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
  await ingest.stop();
  await museIngest.stop();
  museWatcher?.stop();
  db.close();
  await app.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

let museWatcher: { start: () => void; stop: () => void } | null = null;

try {
  await app.listen({ host: HOST, port: resolvePort() });
  // Enabled but sessionless repos get their folder (empty state) from boot.
  await ensureEnabledProjects(db, config.projects, app.log);
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
