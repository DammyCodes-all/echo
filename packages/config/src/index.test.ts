import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEchoConfig, resolveEchoPaths, saveEchoConfig } from "./index";

function testEnv(dir: string): NodeJS.ProcessEnv {
  return { ECHO_CONFIG_DIR: join(dir, "config"), ECHO_DATA_DIR: join(dir, "data") };
}

describe("resolveEchoPaths", () => {
  it("honors explicit overrides", () => {
    const paths = resolveEchoPaths({ ECHO_DATA_DIR: "/d", ECHO_CONFIG_DIR: "/c" });
    expect(paths.dataDir).toBe("/d");
    expect(paths.configFile).toBe("/c/config.json");
  });

  it("falls back to XDG and home defaults", () => {
    const paths = resolveEchoPaths({ XDG_DATA_HOME: "/xdg", XDG_CONFIG_HOME: "/xconfig" });
    expect(paths.dataDir).toBe("/xdg/echo");
    expect(paths.configDir).toBe("/xconfig/echo");
    expect(paths.configFile).toBe("/xconfig/echo/config.json");
  });
});

describe("loadEchoConfig / saveEchoConfig", () => {
  it("returns defaults when no config file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-config-"));
    const config = loadEchoConfig(testEnv(dir));
    expect(config.projects).toEqual([]);
    expect(config.poll_interval_ms).toBe(3000);
    expect(config.opencode_db).toContain(".local/share/opencode/opencode.db");
  });

  it("round-trips a saved config and keeps an explicit opencode_db", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-config-"));
    const env = testEnv(dir);
    saveEchoConfig(
      { projects: ["/repo"], opencode_db: "/custom/oc.db", poll_interval_ms: 500 },
      env,
    );
    const config = loadEchoConfig(env);
    expect(config.projects).toEqual(["/repo"]);
    expect(config.opencode_db).toBe("/custom/oc.db");
    expect(config.poll_interval_ms).toBe(500);
  });
});
