import Fastify from "fastify";

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
const app = Fastify({ logger: true });

app.get("/api/health", async () => ({
  status: "ok",
  version: VERSION,
  mode: process.env.ECHO_MODE === "demo" ? "demo" : "local",
  uptimeMs: Date.now() - startedAt,
}));

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  await app.close();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: HOST, port: resolvePort() });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
