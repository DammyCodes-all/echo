import { describe, expect, it } from "vitest";
import { MUSE_HOOK_EVENTS, resolveHookProject, translateMuseHook } from "./hooks";

describe("translateMuseHook", () => {
  it("covers all 19 documented hook events", () => {
    expect(MUSE_HOOK_EVENTS).toHaveLength(19);
    const kinds = MUSE_HOOK_EVENTS.map(
      (event) =>
        translateMuseHook({
          event,
          payload: { cwd: "/repo", session_id: "s1" },
          projects: ["/repo"],
        }).kind,
    );
    expect(kinds).toEqual([
      "session.started",
      "prompt.submitted",
      "tool.requested",
      "approval.requested",
      "tool.completed",
      "tool.failed",
      "tool.batch",
      "model.call",
      "model.response",
      "capture.compaction",
      "capture.compaction",
      "subagent.started",
      "subagent.stopped",
      "notification",
      "turn.ended",
      "turn.failed",
      "session.ended",
      "session.started",
      "tool.requested",
    ]);
  });

  it("drops unknown events and unattributable projects with diagnostics", () => {
    const unknown = translateMuseHook({ event: "Nope", payload: {}, projects: ["/repo"] });
    expect(unknown.dropped).toBe(true);
    expect(unknown.diagnostics).toContain("unknown_hook_event");

    const outside = translateMuseHook({
      event: "PreToolUse",
      payload: { cwd: "/elsewhere", tool_name: "read" },
      projects: ["/repo"],
    });
    expect(outside.dropped).toBe(true);
    expect(outside.diagnostics).toContain("unattributed_project");
  });

  it("accepts aliased field names, bounds previews and redacts secrets", () => {
    const big = translateMuseHook({
      event: "PostToolUse",
      payload: {
        working_directory: "/repo",
        sessionId: "s1",
        toolName: "bash",
        output: `METAROUTER_TOKEN=${"x".repeat(70_000)}`,
      },
      projects: ["/repo"],
    });
    expect(big.dropped).toBe(false);
    expect(big.projectRoot).toBe("/repo");
    expect(big.toolName).toBe("bash");
    expect(big.diagnostics).toContain("truncation");
    expect(JSON.stringify(big.redactedPayload)).not.toContain("x".repeat(16));
  });
});

describe("resolveHookProject", () => {
  it("matches by canonical root and rejects escapes", () => {
    expect(resolveHookProject("/repo/sub", ["/repo"])).toBe("/repo");
    expect(resolveHookProject("/other", ["/repo"])).toBeNull();
    expect(resolveHookProject(null, ["/repo"])).toBeNull();
  });
});
