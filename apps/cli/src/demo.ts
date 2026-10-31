import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveServerBin } from "@echo/demo";

/**
 * The web dist sits beside the CLI dist in both the repo and the container:
 * apps/cli/dist/index.js -> apps/web/dist.
 */
export function resolveDefaultWebDir(cliEntry: string | undefined): string | null {
  if (typeof cliEntry !== "string" || cliEntry.length === 0) return null;
  const dir = join(dirname(resolve(cliEntry)), "..", "..", "web", "dist");
  return existsSync(join(dir, "index.html")) ? dir : null;
}

export function buildServeEnv(
  bundleDir: string,
  port: number,
  host: string,
): Record<string, string> {
  return {
    ECHO_MODE: "demo",
    ECHO_HOST: host,
    ECHO_DATA_DIR: join(bundleDir, "data"),
    ECHO_DEMO_WEB_DIR: join(bundleDir, "web"),
    ECHO_PORT: String(port),
  };
}

/** Foreground serve: stdio inherits, signals forward, the exit code passes through. */
export function runDemoServe(args: {
  bundleDir: string;
  port: number;
  host: string;
  serverBin?: string;
}): Promise<number> {
  const serverBin = args.serverBin ?? resolveServerBin(process.env, process.argv[1]);
  if (!serverBin) {
    process.stderr.write("demo serve: cannot locate the server bundle\n");
    return Promise.resolve(1);
  }
  const child = spawn("node", [serverBin], {
    env: { ...process.env, ...buildServeEnv(args.bundleDir, args.port, args.host) },
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    });
  }
  return new Promise<number>((promiseResolve) => {
    child.on("error", (error) => {
      process.stderr.write(`demo serve failed: ${String(error).slice(0, 200)}\n`);
      promiseResolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) process.stderr.write(`demo serve ended on ${signal}\n`);
      promiseResolve(code ?? 1);
    });
  });
}
