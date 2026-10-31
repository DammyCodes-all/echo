import { createReadStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadEchoConfig, resolveEchoPaths } from "@echo/config";
import {
  ArchitectureApplyRequestSchema,
  ArchitectureChatRequestSchema,
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
import { createArchitectureService } from "./architecture";
import { createAskService } from "./ask";
import { createChangesService } from "./changes";
import { createChecksV2Service } from "./checks-v2";
import { createCodeIndexService } from "./code-index";
import {
  createDemoPolicy,
  type DemoAdmission,
  type DemoPolicy,
  demoReadonly,
  demoUsageTokens,
  recordedExamples,
  resolveDemoLimits,
  resolveDemoStatic,
} from "./demo";
import { ensureEnabledProjects } from "./enabled-projects";
import { loadLocalEnv } from "./env";
import { createHistoryService } from "./history";
import { createIngest } from "./ingest";
import { createLearnService } from "./learn";
import { createMuseIngest } from "./muse-ingest";
import { createMuseWatcher } from "./muse-watch";
import { createProjectTechStackService } from "./project-tech-stack";
import { buildSessionReview } from "./review-index";
import { readSnapshotFile } from "./snapshot-view";

const VERSION = "0.1.0";
const DEFAULT_PORT = 4783;
const DEMO = process.env.ECHO_MODE === "demo";

function resolvePort(): number {
  const raw = process.env.ECHO_PORT;
  if (raw === undefined || raw === "") return DEFAULT_PORT;

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid ECHO_PORT: ${raw}`);
  }
  return port;
}

function resolveHost(): string {
  const raw = process.env.ECHO_HOST;
  if (raw !== undefined && raw !== "") return raw;
  // The container has no loopback clients; local mode never binds wide.
  return DEMO ? "0.0.0.0" : "127.0.0.1";
}

const startedAt = Date.now();
loadLocalEnv();
const paths = resolveEchoPaths();
mkdirSync(paths.dataDir, { recursive: true });
const db = openEchoDb(join(paths.dataDir, "echo.sqlite"));
const app = Fastify({ logger: true, trustProxy: DEMO });
const changes = createChangesService({ db, dataDir: paths.dataDir, log: app.log });
// Fire-and-forget finalize hook: never awaited (model latency would stall
// polling) and never throws into ingest (errors are logged here).
const changesHook = (sessionId: string): void => {
  void changes
    .maybeGenerateChanges(sessionId)
    .catch((error) =>
      app.log.error({ err: String(error), session_id: sessionId }, "changes finalize failed"),
    );
};
// Quiescence fans out to every finalize hook; each owns its errors, so one
// slow or failing hook never blocks or breaks the others.
const quiescentHook = (sessionId: string): void => {
  changesHook(sessionId);
};
const ingest = createIngest({
  dataDir: paths.dataDir,
  db,
  log: app.log,
  onSessionQuiescent: quiescentHook,
});
const config = loadEchoConfig();
const museIngest = createMuseIngest({
  dataDir: paths.dataDir,
  db,
  log: app.log,
  projects: config.projects,
  onSessionQuiescent: quiescentHook,
});
const ask = createAskService(db, paths.dataDir, { log: app.log });
const checksV2 = createChecksV2Service({ db, dataDir: paths.dataDir, log: app.log });
const history = createHistoryService(db, paths.dataDir);
const codeIndex = createCodeIndexService({ db });
const learn = createLearnService({ db, dataDir: paths.dataDir });
const architecture = createArchitectureService(
  { db, log: app.log },
  {
    ensureIndex: (projectId) => {
      codeIndex.reindex(projectId);
    },
  },
);
const techStack = createProjectTechStackService(
  { db, dataDir: paths.dataDir, log: app.log },
  {
    ensureIndex: (projectId) => {
      codeIndex.reindex(projectId);
    },
  },
);

// Demo visitors each get service instances with an in-memory overlay seeded
// from the baked files, so answers and questions never touch baked data and
// visitors sharing a boot do not share check/ask state. Same-NAT visitors
// still collide; the baked bundle stays untouched either way.
const demoPolicy: DemoPolicy | null = DEMO ? createDemoPolicy(resolveDemoLimits()) : null;
const demoAskServices = new Map<string, ReturnType<typeof createAskService>>();
const demoChecksServices = new Map<string, ReturnType<typeof createChecksV2Service>>();

function askFor(ip: string): ReturnType<typeof createAskService> {
  const cached = demoAskServices.get(ip);
  if (cached) return cached;
  const service = createAskService(db, paths.dataDir, { log: app.log, demo: true });
  demoAskServices.set(ip, service);
  return service;
}

function checksFor(ip: string): ReturnType<typeof createChecksV2Service> {
  const cached = demoChecksServices.get(ip);
  if (cached) return cached;
  const service = createChecksV2Service(
    { db, dataDir: paths.dataDir, log: app.log },
    { demo: true },
  );
  demoChecksServices.set(ip, service);
  return service;
}

async function demoExamples(ip: string, sessionId: string): Promise<string[]> {
  const thread = await askFor(ip).thread(sessionId);
  if (thread.status !== 200 || !("messages" in thread.body)) return [];
  return recordedExamples(thread.body);
}

async function demoLimited(
  reply: FastifyReply,
  verdict: Extract<DemoAdmission, { ok: false }>,
  examples: () => Promise<string[]>,
): Promise<FastifyReply> {
  if (verdict.reason === "rate_limited") {
    if (verdict.retryAfterMs !== null) {
      reply.header("Retry-After", Math.max(1, Math.ceil(verdict.retryAfterMs / 1000)));
    }
    return reply
      .code(429)
      .send({ error: { code: "rate_limited", message: "demo rate limit reached; retry shortly" } });
  }
  return reply.code(429).send({
    error: {
      code: "budget_exhausted",
      message: "demo budget reached; try the recorded examples",
      details: { examples: await examples() },
    },
  });
}

app.get("/api/health", async () => ({
  status: "ok",
  version: VERSION,
  mode: DEMO ? "demo" : "local",
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
  // The reader serves every session (live ones render the in-progress slot);
  // story-era quiet/emptiness filtering is gone with the story pipeline.
  return listSessions(db, request.params.id);
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
  if (DEMO) return reply.code(403).send(demoReadonly());
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

app.get<{ Params: { id: string } }>("/api/projects/:id/architecture", async (request, reply) => {
  const outcome = architecture.get(request.params.id);
  return reply.code(outcome.status).send(outcome.body);
});

app.post<{ Params: { id: string } }>(
  "/api/projects/:id/architecture/generate",
  async (request, reply) => {
    if (DEMO) return reply.code(403).send(demoReadonly());
    const outcome = await architecture.generate(request.params.id);
    return reply.code(outcome.status).send(outcome.body);
  },
);

app.get<{ Params: { id: string } }>(
  "/api/projects/:id/architecture/stream",
  async (request, reply) => {
    const project = getProject(db, request.params.id);
    if (!project) {
      return reply.code(404).send({
        error: { code: "not_found", message: "unknown project" },
      });
    }
    // Hijacked: the socket stays open and the service pushes generation
    // progress plus version broadcasts until the client goes away.
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(": connected\n\n");
    const unsubscribe = architecture.subscribe(request.params.id, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    request.raw.on("close", () => {
      unsubscribe();
    });
  },
);

app.post<{ Params: { id: string } }>(
  "/api/projects/:id/architecture/chat",
  async (request, reply) => {
    if (DEMO) return reply.code(403).send(demoReadonly());
    const parsed = ArchitectureChatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "message is required (max 2000 chars)" },
      });
    }
    const outcome = await architecture.chat(
      request.params.id,
      parsed.data.message,
      parsed.data.pinnedNodeId,
    );
    return reply.code(outcome.status).send(outcome.body);
  },
);

app.post<{ Params: { id: string } }>(
  "/api/projects/:id/architecture/apply",
  async (request, reply) => {
    if (DEMO) return reply.code(403).send(demoReadonly());
    const parsed = ArchitectureApplyRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "patch is required" },
      });
    }
    const outcome = architecture.applyPatch(request.params.id, parsed.data.patch);
    return reply.code(outcome.status).send(outcome.body);
  },
);

app.post<{ Params: { id: string } }>(
  "/api/projects/:id/architecture/undo",
  async (request, reply) => {
    if (DEMO) return reply.code(403).send(demoReadonly());
    const outcome = architecture.undo(request.params.id);
    return reply.code(outcome.status).send(outcome.body);
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
  if (DEMO && demoPolicy) {
    const verdict = demoPolicy.admitAsk(request.ip);
    if (!verdict.ok) {
      return demoLimited(reply, verdict, () => demoExamples(request.ip, request.params.id));
    }
    const outcome = await askFor(request.ip).answer(request.params.id, parsed.data);
    demoPolicy.recordTokens(demoUsageTokens(outcome.usage));
    return reply.code(outcome.status).send(outcome.body);
  }
  // The reader anchors Ask to a change (c_ id) outside the frozen AskRequest
  // schema; forward it raw so the service can scope, while persistence stays
  // on cardId (h_ or null) per the thread contract.
  const rawBody = request.body as { changeId?: unknown };
  const changeId = typeof rawBody.changeId === "string" ? rawBody.changeId : null;
  const outcome = await ask.answer(request.params.id, { ...parsed.data, changeId });
  return reply.code(outcome.status).send(outcome.body);
});

app.get<{ Params: { id: string } }>("/api/sessions/:id/ask/thread", async (request, reply) => {
  const service = DEMO ? askFor(request.ip) : ask;
  const outcome = await service.thread(request.params.id);
  return reply.code(outcome.status).send(outcome.body);
});

app.post<{ Params: { id: string } }>(
  "/api/sessions/:id/checks-v2/generate",
  async (request, reply) => {
    // Demo serves the baked set: no model draft, no persist, same public shape.
    // A missing bake fails closed instead of drafting live.
    if (DEMO) {
      const baked = checksFor(request.ip).state(request.params.id);
      if (
        baked.status === 200 &&
        typeof baked.body === "object" &&
        baked.body !== null &&
        "questions" in baked.body &&
        Array.isArray((baked.body as { questions: unknown }).questions) &&
        (baked.body as { questions: unknown[] }).questions.length === 0
      ) {
        return reply.code(503).send({
          error: { code: "check_unavailable", message: "no baked check for this session" },
        });
      }
      return reply.code(baked.status).send(baked.body);
    }
    const outcome = await checksV2.generate(request.params.id);
    return reply.code(outcome.status).send(outcome.body);
  },
);

app.get<{ Params: { id: string } }>("/api/sessions/:id/checks-v2", async (request, reply) => {
  const service = DEMO ? checksFor(request.ip) : checksV2;
  const outcome = service.state(request.params.id);
  return reply.code(outcome.status).send(outcome.body);
});

app.post<{ Params: { id: string } }>(
  "/api/sessions/:id/checks-v2/check-me",
  async (request, reply) => {
    if (DEMO) return reply.code(403).send(demoReadonly());
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
    if (DEMO && demoPolicy) {
      const verdict = demoPolicy.admitAnswer(request.ip);
      if (!verdict.ok) {
        return demoLimited(reply, verdict, () => demoExamples(request.ip, request.params.id));
      }
      const outcome = await checksFor(request.ip).answer(request.params.id, parsed.data);
      demoPolicy.recordTokens(demoUsageTokens(outcome.usage));
      return reply.code(outcome.status).send(outcome.body);
    }
    const outcome = await checksV2.answer(request.params.id, parsed.data);
    return reply.code(outcome.status).send(outcome.body);
  },
);

app.post<{ Params: { id: string } }>("/api/sessions/:id/checks-v2/skip", async (request, reply) => {
  if (DEMO) return reply.code(403).send(demoReadonly());
  const outcome = checksV2.skip(request.params.id);
  return reply.code(outcome.status).send(outcome.body);
});

app.get<{ Params: { id: string } }>("/api/sessions/:id/changes", async (request, reply) => {
  const outcome = changes.getChanges(request.params.id);
  return reply.code(outcome.status).send(outcome.body);
});

app.post<{ Params: { id: string } }>("/api/sessions/:id/progress", async (request, reply) => {
  const outcome = changes.recordProgress(request.params.id, request.body);
  return reply.code(outcome.status).send(outcome.body);
});

app.get<{ Params: { id: string } }>("/api/sessions/:id/history", async (request, reply) => {
  const outcome = history.forSession(request.params.id);
  return reply.code(outcome.status).send(outcome.body);
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

if (DEMO) {
  // The demo is a public surface: deny framing and MIME sniffing on every
  // response. The full ARCH §17 CSP stays out until a browser pass proves
  // the app renders cleanly under it.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    return payload;
  });
  // Same-origin web assets, registered last: explicit /api routes win over
  // the wildcard regardless of order.
  const demoWebDir = process.env.ECHO_DEMO_WEB_DIR ?? "";
  if (demoWebDir === "") app.log.warn("demo mode without ECHO_DEMO_WEB_DIR: web assets will 404");
  app.get("/*", async (request, reply) => {
    const hit = demoWebDir === "" ? null : resolveDemoStatic(demoWebDir, request.raw.url ?? "/");
    if (!hit) {
      return reply.code(404).send({ error: { code: "not_found", message: "not found" } });
    }
    reply.header("Content-Type", hit.contentType);
    reply.header(
      "Cache-Control",
      hit.immutable ? "public, max-age=31536000, immutable" : "no-store",
    );
    return reply.send(createReadStream(hit.file));
  });
}

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  if (changesTimer !== null) clearInterval(changesTimer);
  await ingest.stop();
  await museIngest.stop();
  museWatcher?.stop();
  db.close();
  await app.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

let museWatcher: { start: () => void; stop: () => void } | null = null;
// Backfill: one session per tick grows changes for old sessions, heals drift
// and fills skeletons with prose when the model is on. Never throws into the
// loop; a slow run simply delays the next tick's pick, never overlaps it
// (the service is idempotent, but overlapping narrations would double spend).
let changesTimer: NodeJS.Timeout | null = null;
let changesBackfillRunning = false;

try {
  await app.listen({ host: resolveHost(), port: resolvePort() });
  if (DEMO) {
    app.log.info("demo mode: ingest disabled, serving baked data");
  } else {
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
    changesTimer = setInterval(() => {
      if (changesBackfillRunning) return;
      let pick: { sessionId: string; reason: string } | null = null;
      try {
        pick = changes.findSessionNeedingChanges(process.env.ECHO_MODEL !== "off");
      } catch (error) {
        app.log.error({ err: String(error) }, "changes backfill pick failed");
        return;
      }
      if (!pick) return;
      changesBackfillRunning = true;
      void changes
        .maybeGenerateChanges(pick.sessionId)
        .then((result) => {
          if (result.outcome === "generated") {
            app.log.info(
              { session_id: pick.sessionId, reason: pick.reason },
              "changes backfill generated",
            );
          }
        })
        .catch((error) =>
          app.log.error(
            { err: String(error), session_id: pick.sessionId },
            "changes backfill failed",
          ),
        )
        .finally(() => {
          changesBackfillRunning = false;
        });
    }, 20_000);
  }
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
