import { describe, expect, it } from "vitest";
import {
  type AttemptLink,
  buildFileAttempts,
  buildFinalLineOrigins,
  type FileVersion,
  hunkFromParsed,
  hunkIdFor,
  linkHunkEvidence,
  normalizePatch,
  parseUnifiedDiffs,
} from "./review-index";

function version(
  snapshotId: string,
  text: string | null,
  eventId: string | null = `evt_${snapshotId}`,
): FileVersion {
  return {
    snapshotId,
    commitOid: `commit_${snapshotId}`,
    trigger: snapshotId === "s1" ? "baseline" : "tool.post",
    eventId,
    takenAt: `2026-10-28T10:0${snapshotId.slice(1)}:00.000Z`,
    text,
    captured: text !== null,
    reason: text === null ? "binary" : null,
  };
}

const link: AttemptLink = {
  eventId: "evt_s2",
  toolCallId: "prt_1",
  toolOutcome: "completed",
  turnId: "turn_1",
  batchId: null,
};

describe("parseUnifiedDiffs", () => {
  it("parses added and deleted files and validates hunk bodies", () => {
    const diffs = parseUnifiedDiffs(
      `diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-goodbye
`,
    );
    expect(diffs.map((diff) => [diff.oldPath, diff.newPath])).toEqual([
      [null, "new.txt"],
      ["old.txt", null],
    ]);
    expect(diffs[0]?.hunks[0]?.lines).toEqual([{ kind: "addition", text: "hello" }]);
  });

  it("rejects a hunk whose body disagrees with its header", () => {
    expect(() =>
      parseUnifiedDiffs(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-a
`),
    ).toThrow(/header says/);
  });

  it("gives trailing whitespace no identity", () => {
    const first = parseUnifiedDiffs(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-a
+b
`)[0]?.hunks[0];
    const second = parseUnifiedDiffs(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-a
+b   
`)[0]?.hunks[0];
    if (!first || !second) throw new Error("fixture hunks missing");
    expect(normalizePatch(first)).toBe(normalizePatch(second));
    expect(hunkIdFor("a.txt", first)).toBe(hunkIdFor("a.txt", second));
  });
});

describe("buildFileAttempts", () => {
  it("marks a deleted intermediate write as reverted", () => {
    const versions = [version("s1", "a\n"), version("s2", "a\nb\n"), version("s3", "a\n")];
    const hunksByTransition = [
      parseUnifiedDiffs(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,2 @@
 a
+b
`)[0]?.hunks ?? [],
      parseUnifiedDiffs(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1 @@
 a
-b
`)[0]?.hunks ?? [],
    ];

    const attempts = buildFileAttempts({
      path: "a.txt",
      versions,
      hunksByTransition,
      linksByTransition: [link, link],
      finalText: "a\n",
    });
    expect(attempts.map((attempt) => attempt.status)).toEqual(["baseline", "reverted"]);
    expect(attempts[1]).toMatchObject({
      confidence: "exact",
      introducedLines: 1,
      survivingLines: 0,
      introducedText: ["b"],
    });
  });

  it("marks an overwritten intermediate write as replaced", () => {
    const versions = [version("s1", "a\n"), version("s2", "a\nb\n"), version("s3", "a\nc\n")];
    const hunksByTransition = [
      parseUnifiedDiffs(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,2 @@
 a
+b
`)[0]?.hunks ?? [],
      parseUnifiedDiffs(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 a
-b
+c
`)[0]?.hunks ?? [],
    ];

    const attempts = buildFileAttempts({
      path: "a.txt",
      versions,
      hunksByTransition,
      linksByTransition: [link, link],
      finalText: "a\nc\n",
    });
    expect(attempts.map((attempt) => attempt.status)).toEqual(["baseline", "replaced", "landed"]);
    expect(attempts[1]).toMatchObject({ replacementText: ["c"] });
  });

  it("does not let a repeated line elsewhere rescue a deleted attempt", () => {
    const versions = [version("s1", "b\n"), version("s2", "b\nb\n"), version("s3", "b\n")];
    const hunksByTransition = [
      parseUnifiedDiffs(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,2 @@
 b
+b
`)[0]?.hunks ?? [],
      parseUnifiedDiffs(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1 @@
 b
-b
`)[0]?.hunks ?? [],
    ];

    const attempts = buildFileAttempts({
      path: "a.txt",
      versions,
      hunksByTransition,
      linksByTransition: [link, link],
      finalText: "b\n",
    });
    expect(attempts[1]?.status).toBe("reverted");
  });

  it("marks uncaptured versions uncertain instead of inventing a dead end", () => {
    const attempts = buildFileAttempts({
      path: "a.txt",
      versions: [version("s1", "a\n"), version("s2", null)],
      hunksByTransition: [[]],
      linksByTransition: [link],
      finalText: "a\n",
    });
    expect(attempts[1]).toMatchObject({ status: "uncertain", confidence: "uncertain" });
  });

  it("treats a file created mid-session as a landed attempt", () => {
    const created: FileVersion = {
      ...version("s1", null),
      captured: false,
      reason: "absent",
    };
    const versions = [created, version("s2", "hello\n")];
    const hunksByTransition = [
      parseUnifiedDiffs(`diff --git a/a.txt b/a.txt
new file mode 100644
--- /dev/null
+++ b/a.txt
@@ -0,0 +1 @@
+hello
`)[0]?.hunks ?? [],
    ];
    const attempts = buildFileAttempts({
      path: "a.txt",
      versions,
      hunksByTransition,
      linksByTransition: [link],
      finalText: "hello\n",
    });
    expect(attempts.map((attempt) => attempt.status)).toEqual(["baseline", "landed"]);
  });

  it("treats a file deleted by the final snapshot as reverted", () => {
    const deleted: FileVersion = {
      ...version("s3", null),
      captured: false,
      reason: "absent",
    };
    const versions = [version("s1", "a\n"), version("s2", "a\nb\n"), deleted];
    const hunksByTransition = [
      parseUnifiedDiffs(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,2 @@
 a
+b
`)[0]?.hunks ?? [],
      parseUnifiedDiffs(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-a
-b
`)[0]?.hunks ?? [],
    ];
    const attempts = buildFileAttempts({
      path: "a.txt",
      versions,
      hunksByTransition,
      linksByTransition: [link, link],
      finalText: null,
    });
    expect(attempts.map((attempt) => attempt.status)).toEqual(["baseline", "reverted"]);
  });
});

describe("line origins and hunk evidence", () => {
  it("traces final lines to the snapshot that introduced them", () => {
    const versions = [version("s1", "a\n"), version("s2", "a\nb\n"), version("s3", "a\nc\n")];
    const hunksByTransition = [
      parseUnifiedDiffs(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,2 @@
 a
+b
`)[0]?.hunks ?? [],
      parseUnifiedDiffs(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 a
-b
+c
`)[0]?.hunks ?? [],
    ];
    const origins = buildFinalLineOrigins({ versions, hunksByTransition, finalText: "a\nc\n" });
    expect(origins).toMatchObject([
      { line: 1, baseline: true, snapshotId: "s1" },
      { line: 2, baseline: false, snapshotId: "s3", eventId: "evt_s3" },
    ]);

    const hunk = hunkFromParsed(
      "a.txt",
      parseUnifiedDiffs(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,2 @@
 a
+c
`)[0]?.hunks[0] ?? { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [] },
    );
    const attempts = buildFileAttempts({
      path: "a.txt",
      versions,
      hunksByTransition,
      linksByTransition: [link, link],
      finalText: "a\nc\n",
    });
    const evidence = linkHunkEvidence({
      hunk,
      origins,
      attempts,
      relatedEvents: [
        {
          eventId: "evt_tool",
          kind: "tool.completed",
          toolCallId: "prt_1",
          turnId: null,
          batchId: null,
          text: "tool write completed a.txt",
        },
      ],
    });
    expect(evidence.filter((entry) => entry.relation === "introduced_by")).toMatchObject([
      { confidence: "exact", snapshotId: "s3", eventId: "evt_s3" },
    ]);
    expect(evidence.some((entry) => entry.relation === "baseline")).toBe(true);
    expect(evidence.filter((entry) => entry.relation === "reverted_attempt")).toMatchObject([
      { confidence: "exact", snapshotId: "s2" },
    ]);
    expect(evidence.filter((entry) => entry.relation === "related_event")).toMatchObject([
      { confidence: "likely", eventId: "evt_tool" },
    ]);
  });

  it("does not attach a reverted attempt to an unrelated hunk in the same file", () => {
    const hunk = hunkFromParsed(
      "a.txt",
      parseUnifiedDiffs(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -10,2 +10,2 @@
 context
-old
+new
`)[0]?.hunks[0] ?? { oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, lines: [] },
    );
    const evidence = linkHunkEvidence({
      hunk,
      origins: [],
      attempts: [
        {
          id: "att_elsewhere",
          path: "a.txt",
          snapshotId: "s2",
          commitOid: "commit_s2",
          trigger: "tool.post",
          eventId: "evt_s2",
          takenAt: "2026-10-28T10:00:00.000Z",
          status: "reverted",
          confidence: "exact",
          introducedLines: 1,
          survivingLines: 0,
          introducedText: ["gone"],
          replacementText: [],
          finalStart: 2,
          finalEnd: 1,
          detail: "elsewhere",
          link,
        },
      ],
      relatedEvents: [],
    });
    expect(evidence.some((entry) => entry.relation === "reverted_attempt")).toBe(false);
  });
});
