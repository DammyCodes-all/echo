import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";

/**
 * Locates the server bundle a demo boots. ECHO_SERVER_BIN wins; otherwise the
 * server dist sits beside the CLI dist in both the repo and the container.
 */
export function resolveServerBin(
  env: NodeJS.ProcessEnv = process.env,
  cliEntry: string | undefined = process.argv[1],
): string | null {
  const override = env.ECHO_SERVER_BIN;
  if (typeof override === "string" && override.length > 0) {
    const resolved = resolve(override);
    return existsSync(resolved) ? resolved : null;
  }
  if (typeof cliEntry !== "string" || cliEntry.length === 0) return null;
  const sibling = join(dirname(resolve(cliEntry)), "..", "..", "server", "dist", "index.js");
  return existsSync(sibling) ? sibling : null;
}

export function findFreePort(): Promise<number> {
  return new Promise((promiseResolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : promiseResolve(port)));
    });
  });
}

export interface SpawnedDemoServer {
  child: ChildProcess;
  stderrTail: () => string;
  stop: () => Promise<void>;
}

/** Boots a demo-mode server against a bundle; the caller owns stop(). */
export function spawnDemoServer(args: {
  serverBin: string;
  bundleDir: string;
  port: number;
  model?: string;
}): SpawnedDemoServer {
  const child = spawn("node", [args.serverBin], {
    env: {
      ...process.env,
      ECHO_MODE: "demo",
      ECHO_MODEL: args.model ?? "off",
      ECHO_HOST: "127.0.0.1",
      ECHO_DATA_DIR: join(args.bundleDir, "data"),
      ECHO_DEMO_WEB_DIR: join(args.bundleDir, "web"),
      ECHO_PORT: String(args.port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4096);
  });
  return {
    child,
    stderrTail: () => stderr,
    stop: () =>
      new Promise<void>((promiseResolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          promiseResolve();
          return;
        }
        const force = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }, 5000);
        force.unref();
        child.once("exit", () => {
          clearTimeout(force);
          promiseResolve();
        });
        try {
          child.kill("SIGTERM");
        } catch {
          clearTimeout(force);
          promiseResolve();
        }
      }),
  };
}
