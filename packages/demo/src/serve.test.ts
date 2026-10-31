import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findFreePort, resolveServerBin } from "./serve";

describe("demo serve", () => {
  it("prefers ECHO_SERVER_BIN when it exists", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-demo-serve-"));
    const bin = join(root, "index.js");
    writeFileSync(bin, "1");
    expect(resolveServerBin({ ECHO_SERVER_BIN: bin }, undefined)).toBe(bin);
    expect(resolveServerBin({ ECHO_SERVER_BIN: join(root, "missing.js") }, undefined)).toBeNull();
  });

  it("resolves the server dist beside the CLI dist", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-demo-serve-"));
    mkdirSync(join(root, "apps", "cli", "dist"), { recursive: true });
    mkdirSync(join(root, "apps", "server", "dist"), { recursive: true });
    const cliEntry = join(root, "apps", "cli", "dist", "index.js");
    writeFileSync(cliEntry, "1");
    const serverBin = join(root, "apps", "server", "dist", "index.js");
    writeFileSync(serverBin, "1");
    expect(resolveServerBin({}, cliEntry)).toBe(serverBin);
    expect(resolveServerBin({}, join(root, "elsewhere", "cli.js"))).toBeNull();
    expect(resolveServerBin({}, undefined)).toBeNull();
  });

  it("finds a bindable free port", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    const { createServer } = await import("node:net");
    await new Promise<void>((promiseResolve, reject) => {
      const server = createServer();
      server.on("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.close((error) => (error ? reject(error) : promiseResolve()));
      });
    });
  });
});
