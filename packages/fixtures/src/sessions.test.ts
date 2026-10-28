import { hunkIdFor, type ParsedDiffHunk } from "@echo/tape";
import { describe, expect, it } from "vitest";
import { buildAllStorySessions, type FixtureStorySession } from "./sessions";

type TestDiffLine = { kind: "context" | "deletion" | "addition"; text: string };

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function reconstructLines(patch: string): TestDiffLine[] {
  return patch.split("\n").map((line) => {
    const prefix = line[0];
    if (prefix !== " " && prefix !== "-" && prefix !== "+") {
      throw new Error(`unparseable patch line in fixture: ${line}`);
    }
    return {
      kind: prefix === " " ? "context" : prefix === "-" ? "deletion" : "addition",
      text: line.slice(1),
    };
  });
}

/** Test-local unified-diff application: proves fixture diffs and version
 *  texts agree without shipping a diff engine in the package. */
function applyHunks(baseText: string, hunks: ParsedDiffHunk[]): string {
  const base = splitLines(baseText);
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = hunk.oldStart - 1;
    while (cursor < start) {
      const line = base[cursor];
      if (line === undefined) throw new Error("hunk starts past end of file");
      out.push(line);
      cursor += 1;
    }
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        expect(base[cursor]).toBe(line.text);
        out.push(line.text);
        cursor += 1;
      } else if (line.kind === "deletion") {
        expect(base[cursor]).toBe(line.text);
        cursor += 1;
      } else {
        out.push(line.text);
      }
    }
  }
  while (cursor < base.length) {
    const line = base[cursor];
    if (line === undefined) throw new Error("cursor past end of file");
    out.push(line);
    cursor += 1;
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

function parseHunks(diffText: string): ParsedDiffHunk[] {
  const hunks: ParsedDiffHunk[] = [];
  let current: ParsedDiffHunk | null = null;
  for (const rawLine of diffText.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rawLine);
    if (header?.[1] && header[3]) {
      current = {
        oldStart: Number(header[1]),
        oldLines: Number(header[2] ?? "1"),
        newStart: Number(header[3]),
        newLines: Number(header[4] ?? "1"),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (rawLine.startsWith(" ") || rawLine.startsWith("-") || rawLine.startsWith("+")) {
      current.lines.push({
        kind: rawLine.startsWith(" ")
          ? "context"
          : rawLine.startsWith("-")
            ? "deletion"
            : "addition",
        text: rawLine.slice(1),
      });
    }
  }
  return hunks;
}

function bySlug(sessions: FixtureStorySession[], slug: string): FixtureStorySession {
  const found = sessions.find((session) => session.slug === slug);
  if (!found) throw new Error(`fixture session missing: ${slug}`);
  return found;
}

describe("story fixture sessions", () => {
  it("builds six deterministic sessions", () => {
    const first = buildAllStorySessions();
    const second = buildAllStorySessions();
    expect(first.map((session) => session.slug)).toEqual([
      "payment-retry",
      "routine",
      "research",
      "failed-deploy",
      "partial-gap",
      "multi-topic",
    ]);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("keeps tape positions dense with namespaced unique event ids", () => {
    const sessions = buildAllStorySessions();
    const seen = new Set<string>();
    for (const session of sessions) {
      expect(session.tape.map((event) => event.tape_seq)).toEqual(
        session.tape.map((_, index) => index + 1),
      );
      for (const event of session.tape) {
        expect(event.session_id).toBe(session.sessionId);
        expect(event.project_id).toBe(session.projectId);
        expect(event.event_id.startsWith(`fixture-${session.slug}-`)).toBe(true);
        expect(seen.has(event.event_id)).toBe(false);
        seen.add(event.event_id);
      }
      expect(session.prompts.length).toBeGreaterThan(0);
    }
  });

  it("uses canonical hunk ids recomputed from the patch", () => {
    const sessions = buildAllStorySessions();
    for (const session of sessions) {
      for (const hunk of session.hunks) {
        const reconstructed: ParsedDiffHunk = {
          oldStart: hunk.oldStart,
          oldLines: hunk.oldLines,
          newStart: hunk.newStart,
          newLines: hunk.newLines,
          lines: reconstructLines(hunk.patch),
        };
        expect(hunk.id).toBe(hunkIdFor(hunk.path, reconstructed));
        expect(hunk.id).toMatch(/^h_[0-9a-f]{16}$/);
      }
    }
  });

  it("keeps diffs and version texts consistent", () => {
    const sessions = buildAllStorySessions();
    for (const session of sessions) {
      for (const file of session.files) {
        file.transitionDiffs.forEach((diff, index) => {
          const parent = index === 0 ? file.baseline : (file.versions[index - 1] as string);
          expect(applyHunks(parent, parseHunks(diff))).toBe(file.versions[index]);
        });
        const last = file.versions[file.versions.length - 1] ?? file.baseline;
        expect(applyHunks(file.baseline, parseHunks(file.finalDiff))).toBe(last);
      }
    }
  });

  it("leaves the synthetic secret to the legacy builder", () => {
    const sessions = buildAllStorySessions();
    for (const session of sessions) {
      expect(JSON.stringify(session.tape)).not.toContain("sk-");
    }
  });

  it("payment retry has no observed verification", () => {
    const session = bySlug(buildAllStorySessions(), "payment-retry");
    expect(session.runs).toHaveLength(1);
    expect(session.runs[0]).toMatchObject({ outcome: "failed", exitCode: 1 });
    expect(session.runs.some((run) => run.outcome === "ok")).toBe(false);
    expect(session.hunks).toHaveLength(1);
    expect(session.attempts.map((attempt) => attempt.status)).toEqual(["baseline", "landed"]);
  });

  it("routine session lands mechanically with a passing run", () => {
    const session = bySlug(buildAllStorySessions(), "routine");
    expect(session.hunks.length).toBeGreaterThan(0);
    expect(session.attempts.map((attempt) => attempt.status)).toEqual(["baseline", "landed"]);
    expect(session.runs[0]).toMatchObject({ outcome: "ok", exitCode: 0 });
  });

  it("research session changes no files and records no runs", () => {
    const session = bySlug(buildAllStorySessions(), "research");
    expect(session.prompts).toHaveLength(2);
    expect(session.hunks).toEqual([]);
    expect(session.attempts).toEqual([]);
    expect(session.runs).toEqual([]);
    expect(session.files).toEqual([]);
  });

  it("failed session links a side-effecting failure", () => {
    const session = bySlug(buildAllStorySessions(), "failed-deploy");
    expect(session.attempts.map((attempt) => attempt.status)).toEqual([
      "baseline",
      "failed_with_side_effect",
    ]);
    expect(session.tape.some((event) => event.kind === "turn.failed")).toBe(true);
    expect(session.runs[0]).toMatchObject({ outcome: "failed", exitCode: 1 });
  });

  it("partial session jumps the source sequence across a gap event", () => {
    const session = bySlug(buildAllStorySessions(), "partial-gap");
    const gaps = session.tape.filter((event) => event.kind === "capture.gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.payload).toMatchObject({
      code: "sequence_jump",
      from_sequence: 4,
      to_sequence: 9,
    });
    const sources = session.tape
      .map((event) => event.source.sequence)
      .filter((sequence): sequence is number => sequence !== null);
    expect(sources).toEqual([3, 4, 9, 10, 11]);
    expect(session.attempts.map((attempt) => attempt.status)).toEqual(["baseline", "landed"]);
  });

  it("multi-topic session reverts then lands, with an unrelated failure", () => {
    const session = bySlug(buildAllStorySessions(), "multi-topic");
    expect(session.prompts).toHaveLength(3);
    const homeAttempts = session.attempts.filter((attempt) => attempt.path === "src/home.ts");
    expect(homeAttempts.map((attempt) => attempt.status)).toEqual([
      "baseline",
      "replaced",
      "landed",
    ]);
    const readmeAttempts = session.attempts.filter((attempt) => attempt.path === "README.md");
    expect(readmeAttempts.map((attempt) => attempt.status)).toEqual(["baseline", "landed"]);
    expect(session.attempts.some((attempt) => attempt.link.toolCallId === "call_lint_triv")).toBe(
      false,
    );
    expect(session.hunks).toHaveLength(2);
    expect(session.runs.map((run) => run.outcome).sort()).toEqual(["failed", "ok"]);
  });
});
