import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runHookCommand } from "./hook";

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), "echo-cli-hook-"));
}

describe("runHookCommand", () => {
  it("spools a translated hook event and always exits 0", () => {
    const result = runHookCommand({
      agent: "muse",
      event: "PreToolUse",
      rawStdin: JSON.stringify({ session_id: "s1", cwd: "/repo", tool_name: "read" }),
      projects: ["/repo"],
      dataDir: dataDir(),
      receivedAt: "2026-10-28T10:00:00.000Z",
    });
    expect(result).toMatchObject({ exitCode: 0, spooled: true, pruned: 0 });
    expect(result.path).toBeTypeOf("string");
    const stored = JSON.parse(readFileSync(result.path as string, "utf8")) as {
      kind: string;
      dropped: boolean;
    };
    expect(stored.kind).toBe("tool.requested");
    expect(stored.dropped).toBe(false);
  });

  it("ignores unknown agents without spooling", () => {
    const result = runHookCommand({
      agent: "other-agent",
      event: "PreToolUse",
      rawStdin: "{}",
      projects: ["/repo"],
      dataDir: dataDir(),
    });
    expect(result).toEqual({ exitCode: 0, spooled: false, path: null, pruned: 0 });
  });

  it("files invalid and unattributable input as dropped diagnostics", () => {
    const root = dataDir();
    const bad = runHookCommand({
      agent: "muse",
      event: "PreToolUse",
      rawStdin: "{oops",
      projects: ["/repo"],
      dataDir: root,
    });
    expect(bad.exitCode).toBe(0);
    expect(bad.spooled).toBe(true);
    const storedBad = JSON.parse(readFileSync(bad.path as string, "utf8")) as {
      diagnostics: string[];
    };
    expect(storedBad.diagnostics).toContain("hook_stdin_invalid_json");

    const outside = runHookCommand({
      agent: "muse",
      event: "SessionStart",
      rawStdin: JSON.stringify({ session_id: "s9", cwd: "/elsewhere" }),
      projects: ["/repo"],
      dataDir: root,
    });
    const storedOutside = JSON.parse(readFileSync(outside.path as string, "utf8")) as {
      diagnostics: string[];
      dropped: boolean;
    };
    expect(storedOutside.dropped).toBe(true);
    expect(storedOutside.diagnostics).toContain("unattributed_project");
  });
});
