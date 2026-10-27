import { describe, expect, it } from "vitest";
import { buildFixtureTape, FIXTURE_SYNTHETIC_SECRET } from "./index";

describe("fixture tape", () => {
  it("covers the ARCHITECTURE §22 sequence", () => {
    const tape = buildFixtureTape();
    const kinds = tape.events.map((event) => event.kind);
    for (const kind of [
      "tool.failed",
      "file.snapshot",
      "subagent.started",
      "subagent.stopped",
      "turn.failed",
      "session.ended",
    ]) {
      expect(kinds).toContain(kind);
    }
    // Reverted edit: same path written twice; rapid pair on a second file.
    const writes = tape.events.filter((event) => event.kind === "tool.requested");
    expect(writes.length).toBeGreaterThanOrEqual(5);
    // Sequence numbers are dense and ordered.
    expect(tape.events.map((event) => event.tape_seq)).toEqual(
      tape.events.map((_, index) => index + 1),
    );
  });

  it("keeps the synthetic secret raw and shaped for the redaction gate", () => {
    const tape = buildFixtureTape();
    const serialized = JSON.stringify(tape.events);
    expect(serialized).toContain(FIXTURE_SYNTHETIC_SECRET);
    // Shaped like a real key (sk- + 22 chars) so the gate's api-key-prefix
    // rule catches it; the strip itself is proven in @echo/redaction tests.
    // Full fixture→gate proof belongs in eval/ once the loop is wired.
    expect(FIXTURE_SYNTHETIC_SECRET).toMatch(/^sk-[A-Za-z0-9_-]{20,}$/);
  });

  it("records binary and .env skips as diagnostics, never content", () => {
    const tape = buildFixtureTape();
    const snapshot = tape.events.find((event) => event.kind === "file.snapshot");
    expect(snapshot?.diagnostics.join(" ")).toContain("binary skipped");
    expect(snapshot?.diagnostics.join(" ")).toContain(".env ignored");
    // The snapshot event carries a trigger reference, not file bytes.
    expect(JSON.stringify(snapshot?.payload)).not.toContain("PNG");
    expect(snapshot?.payload).not.toHaveProperty("content");
  });
});
