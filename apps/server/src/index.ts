import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveEchoPaths } from "@echo/config";
import { listProjects, listSessions, openEchoDb, readEvents } from "@echo/db";
import Fastify from "fastify";
import { createIngest } from "./ingest";

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
const paths = resolveEchoPaths();
mkdirSync(paths.dataDir, { recursive: true });
const db = openEchoDb(join(paths.dataDir, "echo.sqlite"));
const app = Fastify({ logger: true });
const ingest = createIngest({ dataDir: paths.dataDir, db, log: app.log });

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

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  ingest.stop();
  db.close();
  await app.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: HOST, port: resolvePort() });
  ingest.start();
  const initial = await ingest.runOnce();
  if (initial.eventsAdded > 0) {
    app.log.info({ ...initial }, "ingested opencode sessions");
  }
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
