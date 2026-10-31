import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildServeEnv, resolveDefaultWebDir } from "./demo";

describe("demo cli", () => {
  it("resolves the web dist beside the CLI dist", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-demo-cli-"));
    mkdirSync(join(root, "apps", "cli", "dist"), { recursive: true });
    mkdirSync(join(root, "apps", "web", "dist"), { recursive: true });
    writeFileSync(join(root, "apps", "web", "dist", "index.html"), "<html></html>");
    expect(resolveDefaultWebDir(join(root, "apps", "cli", "dist", "index.js"))).toBe(
      join(root, "apps", "web", "dist"),
    );
    expect(resolveDefaultWebDir(join(root, "elsewhere", "cli.js"))).toBeNull();
    expect(resolveDefaultWebDir(undefined)).toBeNull();
  });

  it("builds the demo serve environment", () => {
    expect(buildServeEnv("/tmp/bundle", 8080, "127.0.0.1")).toEqual({
      ECHO_MODE: "demo",
      ECHO_HOST: "127.0.0.1",
      ECHO_DATA_DIR: join("/tmp", "bundle", "data"),
      ECHO_DEMO_WEB_DIR: join("/tmp", "bundle", "web"),
      ECHO_PORT: "8080",
    });
  });
});
