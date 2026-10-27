import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOOK_SPOOL_CAP, runMuseHook, spoolDir, spoolEntryKey } from "./spool";

describe("runMuseHook", () => {
  it("spools a translated redacted hook event", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-spool-"));
    const result = runMuseHook({
      dataDir,
      event: "PreToolUse",
      rawStdin: JSON.stringify({ session_id: "s1", cwd: "/repo", tool_name: "read" }),
      stdinTruncated: false,
      projects: ["/repo"],
      receivedAt: "2026-10-28T10:00:00.000Z",
    });
    expect(result.pruned).toBe(0);
    const stored = JSON.parse(readFileSync(result.path, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({
      v: 1,
      sessionId: "s1",
      projectRoot: "/repo",
      kind: "tool.requested",
      dropped: false,
    });
    expect(result.path.startsWith(spoolDir(dataDir, "s1"))).toBe(true);
  });

  it("files unattributable and malformed input as dropped diagnostics", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-spool-drop-"));
    const outside = runMuseHook({
      dataDir,
      event: "PreToolUse",
      rawStdin: JSON.stringify({ session_id: "s9", cwd: "/elsewhere" }),
      stdinTruncated: false,
      projects: ["/repo"],
      receivedAt: "2026-10-28T10:00:00.000Z",
    });
    const storedOutside = JSON.parse(readFileSync(outside.path, "utf8")) as {
      diagnostics: string[];
      sessionId: string;
    };
    expect(storedOutside.diagnostics).toContain("unattributed_project");
    expect(storedOutside.sessionId).toBe("s9");

    const bad = runMuseHook({
      dataDir,
      event: "PreToolUse",
      rawStdin: "{oops",
      stdinTruncated: false,
      projects: ["/repo"],
      receivedAt: "2026-10-28T10:00:01.000Z",
    });
    const storedBad = JSON.parse(readFileSync(bad.path, "utf8")) as { diagnostics: string[] };
    expect(storedBad.diagnostics).toContain("hook_stdin_invalid_json");

    const big = runMuseHook({
      dataDir,
      event: "PreToolUse",
      rawStdin: "{}",
      stdinTruncated: true,
      projects: ["/repo"],
      receivedAt: "2026-10-28T10:00:02.000Z",
    });
    const storedBig = JSON.parse(readFileSync(big.path, "utf8")) as { diagnostics: string[] };
    expect(storedBig.diagnostics).toContain("hook_payload_oversized");
  });

  it("prunes beyond the per-session cap, oldest first", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "echo-spool-prune-"));
    const dir = spoolDir(dataDir, "s1");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < HOOK_SPOOL_CAP + 5; i++) {
      const name = `2026-01-01T00-00-00-000-${String(i).padStart(4, "0")}-seed.json`;
      writeFileSync(join(dir, name), "{}\n");
    }
    const result = runMuseHook({
      dataDir,
      event: "Stop",
      rawStdin: JSON.stringify({ session_id: "s1", cwd: "/repo" }),
      stdinTruncated: false,
      projects: ["/repo"],
      receivedAt: "2026-10-28T10:00:00.000Z",
    });
    expect(result.pruned).toBe(6);
    expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(HOOK_SPOOL_CAP);
  });

  it("keys spool entries deterministically without the receipt timestamp", () => {
    const entry = {
      sessionId: "s1",
      kind: "tool.requested",
      toolName: "read",
      payload: { a: 1 },
      diagnostics: [] as string[],
    };
    expect(spoolEntryKey(entry)).toBe(spoolEntryKey(entry));
    expect(spoolEntryKey({ ...entry, payload: { a: 2 } })).not.toBe(spoolEntryKey(entry));
  });
});
