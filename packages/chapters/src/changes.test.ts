import { ChangeSchema } from "@echo/contracts";
import { describe, expect, it } from "vitest";
import {
  buildSessionSummaryFromDigests,
  buildSkeletonChange,
  type ChangeGroup,
  countTokens,
  DIGEST_MAX_TOKENS,
  DIGEST_MIN_TOKENS,
  groupDiffIntoChanges,
  hashDiffId,
  isStaleByHash,
  isTrivialFile,
  MAX_FILES_PER_CHANGE,
  mergeSessionGroups,
  normalizeDiffForId,
  rollupIdFor,
  type SnapshotPair,
  sessionBudget,
  splitFilesByArea,
} from "./changes";

const PAIR: SnapshotPair = { prevOid: "a".repeat(40), nextOid: "b".repeat(40) };

function realDiff(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,4 +1,6 @@",
    " const a = 1;",
    "+const b = compute(a);",
    "+const c = transform(b);",
    " return finish(c);",
    "",
  ].join("\n");
}

const LOGIN_DIFF = [
  "diff --git a/src/auth/login.ts b/src/auth/login.ts",
  "--- a/src/auth/login.ts",
  "+++ b/src/auth/login.ts",
  "@@ -10,6 +10,12 @@ export function login(name) {",
  "   const user = findUser(name);",
  "+  if (!user) {",
  '+    throw new Error("unknown user");',
  "+  }",
  "+  const token = signToken(user);",
  "+  auditLog(user);",
  "+  return token;",
  "   return signToken(user);",
  " }",
  "",
].join("\n");

const TYPO_DIFF = [
  "diff --git a/src/greet.ts b/src/greet.ts",
  "--- a/src/greet.ts",
  "+++ b/src/greet.ts",
  "@@ -3,3 +3,3 @@ export function greet(name) {",
  "-  return gretting(name);",
  "+  return greeting(name);",
  " }",
  "",
].join("\n");

const COMMENT_DIFF = [
  "diff --git a/src/notes.ts b/src/notes.ts",
  "--- a/src/notes.ts",
  "+++ b/src/notes.ts",
  "@@ -1,3 +1,3 @@",
  "-// old one",
  "-// old two",
  "+// new one",
  "+// new two",
  " export const x = 1;",
  "",
].join("\n");

function sentences(text: string): number {
  return text
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

describe("hashDiffId", () => {
  it("formats as c_ plus 16 hex chars and is deterministic", () => {
    const normalized = normalizeDiffForId([{ path: "a.ts", diff: LOGIN_DIFF }]);
    const first = hashDiffId(normalized, PAIR.prevOid, PAIR.nextOid);
    expect(first).toMatch(/^c_[0-9a-f]{16}$/);
    expect(hashDiffId(normalized, PAIR.prevOid, PAIR.nextOid)).toBe(first);
  });

  it("changes when the oids or the diff change", () => {
    const normalized = normalizeDiffForId([{ path: "a.ts", diff: LOGIN_DIFF }]);
    const base = hashDiffId(normalized, PAIR.prevOid, PAIR.nextOid);
    expect(hashDiffId(normalized, "c".repeat(40), PAIR.nextOid)).not.toBe(base);
    expect(hashDiffId("other\n", PAIR.prevOid, PAIR.nextOid)).not.toBe(base);
  });

  it("ignores CRLF, trailing whitespace, and file order", () => {
    const files = [
      { path: "b.ts", diff: realDiff("b.ts") },
      { path: "a.ts", diff: LOGIN_DIFF },
    ];
    const messy = normalizeDiffForId([
      {
        path: "a.ts",
        diff: `${LOGIN_DIFF.replace(/\n/g, "\r\n").replace("auditLog(user);", "auditLog(user);   ")}`,
      },
      { path: "b.ts", diff: realDiff("b.ts") },
    ]);
    expect(normalizeDiffForId(files)).toBe(messy);
  });
});

describe("isTrivialFile", () => {
  it("flags single-line, comment-only, and whitespace-only diffs", () => {
    expect(isTrivialFile(TYPO_DIFF)).toBe(true);
    expect(isTrivialFile(COMMENT_DIFF)).toBe(true);
    const whitespace = "@@ -1,2 +1,2 @@\n-const a=1;\n+const  a = 1;\n";
    expect(isTrivialFile(whitespace)).toBe(true);
  });

  it("keeps multi-line logic changes substantive", () => {
    expect(isTrivialFile(LOGIN_DIFF)).toBe(false);
    expect(isTrivialFile(realDiff("src/x.ts"))).toBe(false);
  });
});

describe("groupDiffIntoChanges", () => {
  it("keeps a single file in one group", () => {
    const groups = groupDiffIntoChanges({
      files: [{ path: "src/auth/login.ts", diff: LOGIN_DIFF }],
      prompts: [],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("change");
    expect(groups[0]?.files.map((file) => file.path)).toEqual(["src/auth/login.ts"]);
    expect(groups[0]?.promptRefs).toEqual([]);
  });

  it("folds typos and comment edits into one small group", () => {
    const groups = groupDiffIntoChanges({
      files: [
        { path: "src/greet.ts", diff: TYPO_DIFF },
        { path: "src/notes.ts", diff: COMMENT_DIFF },
        { path: "src/auth/login.ts", diff: LOGIN_DIFF },
      ],
      prompts: ["Fix the typo in greet.ts", "Rework login.ts flow"],
    });
    expect(groups).toHaveLength(2);
    const small = groups.find((group) => group.kind === "small");
    const change = groups.find((group) => group.kind === "change");
    expect(small?.files.map((file) => file.path)).toEqual(["src/greet.ts", "src/notes.ts"]);
    expect(small?.promptRefs).toEqual([0]);
    expect(change?.files.map((file) => file.path)).toEqual(["src/auth/login.ts"]);
    expect(change?.promptRefs).toEqual([1]);
  });

  it("chunks five substantive files into two balanced groups", () => {
    const files = ["e.ts", "d.ts", "c.ts", "b.ts", "a.ts"].map((name) => ({
      path: `src/${name}`,
      diff: realDiff(`src/${name}`),
    }));
    const groups = groupDiffIntoChanges({ files, prompts: [] });
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.files.length)).toEqual([3, 2]);
    expect(groups.flatMap((group) => group.files.map((file) => file.path))).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
      "src/e.ts",
    ]);
  });

  it("carries createdFrom provenance from input to groups", () => {
    const createdFrom = { kind: "tape_range", startSeq: 3, endSeq: 9 } as const;
    const groups = groupDiffIntoChanges({
      files: [{ path: "src/auth/login.ts", diff: LOGIN_DIFF }],
      prompts: [],
      createdFrom,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.createdFrom).toEqual(createdFrom);
    const built = buildSkeletonChange(groups[0] as ChangeGroup, PAIR);
    expect(built.createdFrom).toEqual(createdFrom);
    expect(ChangeSchema.safeParse(built).success).toBe(true);
  });

  it("returns no groups for an empty file list", () => {
    expect(groupDiffIntoChanges({ files: [], prompts: ["hello"] })).toEqual([]);
  });

  it("splits a wide trivial fold into area chunks of at most 10 files", () => {
    const typo = (path: string) => ({
      path,
      diff: TYPO_DIFF.replaceAll("src/greet.ts", path),
    });
    const files = [
      ...Array.from({ length: 12 }, (_, i) => typo(`apps/web/f${String(i).padStart(2, "0")}.ts`)),
      ...Array.from({ length: 3 }, (_, i) => typo(`docs/n${i}.md`)),
    ];
    const groups = groupDiffIntoChanges({ files, prompts: [] });
    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.kind === "small")).toBe(true);
    expect(groups.map((group) => group.files.length)).toEqual([10, 2, 3]);
    expect(groups[0]?.files.map((file) => file.path)).toEqual(
      Array.from({ length: 10 }, (_, i) => `apps/web/f${String(i).padStart(2, "0")}.ts`),
    );
  });
});

describe("splitFilesByArea", () => {
  it("groups by top directory and caps chunks at 10", () => {
    const files = [
      ...Array.from({ length: 12 }, (_, i) => ({ path: `b/f${i}.ts`, diff: "" })),
      ...Array.from({ length: 3 }, (_, i) => ({ path: `a/n${i}.md`, diff: "" })),
      { path: "root.txt", diff: "" },
    ];
    const chunks = splitFilesByArea(files);
    // Areas sort by name ("(root)" sorts first); b chunks 10 + 2.
    expect(chunks.map((chunk) => chunk.length)).toEqual([1, 3, 10, 2]);
    expect(chunks[0]?.map((file) => file.path)).toEqual(["root.txt"]);
    expect(chunks[1]?.map((file) => file.path)).toEqual(["a/n0.md", "a/n1.md", "a/n2.md"]);
    expect(chunks.flat().length).toBe(files.length);
  });

  it("is deterministic under shuffle", () => {
    const files = Array.from({ length: 25 }, (_, i) => ({
      path: `src/g${i}.ts`,
      diff: "",
    }));
    const once = splitFilesByArea(files).map((chunk) => chunk.map((file) => file.path));
    const twice = splitFilesByArea([...files].reverse()).map((chunk) =>
      chunk.map((file) => file.path),
    );
    expect(twice).toEqual(once);
    expect(once.map((chunk) => chunk.length)).toEqual([10, 10, 5]);
  });
});

describe("rollupIdFor", () => {
  it("is stable per index and keeps index 0 on the original seed", () => {
    const sessionId = "ses_rollup";
    expect(rollupIdFor(sessionId)).toBe(rollupIdFor(sessionId, 0));
    expect(rollupIdFor(sessionId, 0)).toMatch(/^c_[0-9a-f]{16}$/);
    expect(rollupIdFor(sessionId, 1)).toMatch(/^c_[0-9a-f]{16}$/);
    expect(rollupIdFor(sessionId, 1)).not.toBe(rollupIdFor(sessionId, 0));
    expect(rollupIdFor(sessionId, 1)).toBe(rollupIdFor(sessionId, 1));
  });
});

describe("buildSkeletonChange", () => {
  const group: ChangeGroup = {
    kind: "change",
    files: [{ path: "src/auth/login.ts", diff: LOGIN_DIFF }],
    promptRefs: [0],
  };

  it("is deterministic and satisfies the Slice A caps", () => {
    const first = buildSkeletonChange(group, PAIR);
    expect(buildSkeletonChange(group, PAIR)).toEqual(first);
    expect(ChangeSchema.parse(first)).toEqual(first);
    expect(first.id).toMatch(/^c_[0-9a-f]{16}$/);
    expect(first.version).toBe(1);
    expect(first.snapshotPair).toEqual({ prevOid: PAIR.prevOid, nextOid: PAIR.nextOid });
    expect(first.createdFrom).toEqual({
      kind: "snapshot_pair",
      prevOid: PAIR.prevOid,
      nextOid: PAIR.nextOid,
    });
    const titleWords = first.title.split(/\s+/);
    expect(titleWords.length).toBeGreaterThan(0);
    expect(titleWords.length).toBeLessThanOrEqual(8);
    expect(sentences(first.summary)).toBeGreaterThanOrEqual(2);
    expect(sentences(first.summary)).toBeLessThanOrEqual(3);
    expect(first.before.length).toBeGreaterThanOrEqual(1);
    expect(first.before.length).toBeLessThanOrEqual(2);
    expect(first.now.length).toBeGreaterThanOrEqual(1);
    expect(first.now.length).toBeLessThanOrEqual(2);
    for (const entry of [...first.before, ...first.now]) {
      expect(entry.length).toBeGreaterThan(0);
    }
    expect(first.howItWorks.length).toBeGreaterThanOrEqual(3);
    expect(first.howItWorks.length).toBeLessThanOrEqual(5);
    expect(first.headsUp).toEqual([]);
    expect(first.files.map((file) => file.path)).toEqual(["src/auth/login.ts"]);
    for (const file of first.files) {
      expect(file.note.length).toBeGreaterThan(0);
    }
    const tokens = countTokens(first.digest);
    expect(tokens).toBeGreaterThanOrEqual(DIGEST_MIN_TOKENS);
    expect(tokens).toBeLessThanOrEqual(DIGEST_MAX_TOKENS);
  });

  it("keeps the digest in range for tiny and crowded groups", () => {
    const tiny: ChangeGroup = {
      kind: "small",
      files: [{ path: "a.ts", diff: TYPO_DIFF }],
      promptRefs: [],
    };
    const crowded: ChangeGroup = {
      kind: "small",
      files: ["m.ts", "l.ts", "k.ts", "j.ts", "i.ts", "h.ts", "g.ts"].map((name) => ({
        path: `src/${name}`,
        diff: TYPO_DIFF,
      })),
      promptRefs: [],
    };
    for (const candidate of [tiny, crowded]) {
      const change = buildSkeletonChange(candidate, PAIR);
      expect(ChangeSchema.safeParse(change).success).toBe(true);
      const tokens = countTokens(change.digest);
      expect(tokens).toBeGreaterThanOrEqual(DIGEST_MIN_TOKENS);
      expect(tokens).toBeLessThanOrEqual(DIGEST_MAX_TOKENS);
    }
  });

  it("skips howItWorks for trivial groups and varies the verb", () => {
    const small: ChangeGroup = {
      kind: "small",
      files: [{ path: "a.ts", diff: TYPO_DIFF }],
      promptRefs: [],
    };
    expect(buildSkeletonChange(small, PAIR).howItWorks).toEqual([]);
    expect(buildSkeletonChange(small, PAIR).title.startsWith("Fix")).toBe(true);
    expect(buildSkeletonChange(group, PAIR).title.startsWith("Add")).toBe(true);
  });
});

describe("buildSessionSummaryFromDigests", () => {
  it("stays at 2-3 plain sentences and uses digest words only", () => {
    const first = buildSkeletonChange(
      { kind: "change", files: [{ path: "src/auth/login.ts", diff: LOGIN_DIFF }], promptRefs: [] },
      PAIR,
    );
    const second = buildSkeletonChange(
      { kind: "small", files: [{ path: "src/greet.ts", diff: TYPO_DIFF }], promptRefs: [] },
      PAIR,
    );
    const summary = buildSessionSummaryFromDigests([first.digest, second.digest]);
    expect(sentences(summary)).toBe(3);
    const glue = new Set(
      "this session contains reviewed change changes they span file files across the recorded in short no nothing to summarize yet and is are more".split(
        " ",
      ),
    );
    const vocab = new Set(
      [first.digest, second.digest]
        .flatMap((digest) => digest.split(/\s+/))
        .map((token) => token.replace(/[,.:;]+$/, "").toLowerCase()),
    );
    for (const raw of summary.split(/\s+/)) {
      const word = raw.replace(/[,.:;!?/]+$/, "").toLowerCase();
      // Numerals are derived counts (digest array length, unique file
      // tokens), not invented content; the exact count is asserted below.
      expect(glue.has(word) || vocab.has(word) || word === "" || /^\d+$/.test(word)).toBe(true);
    }
    expect(summary).toContain("2 reviewed changes");
    expect(summary).toContain("2 files");
  });

  it("caps the excerpt list with a derived overflow count", () => {
    const digests = Array.from({ length: 26 }, (_, i) =>
      [`digest${i} alpha beta gamma delta epsilon zeta eta`, "filler words here"].join(" "),
    );
    const summary = buildSessionSummaryFromDigests(digests);
    expect(sentences(summary)).toBe(3);
    expect(summary).toContain("26 reviewed changes");
    expect(summary).toContain("and 21 more");
    expect(summary).not.toContain("digest5");
    expect(summary).toContain("digest0");
  });

  it("handles empty and single digests", () => {
    expect(sentences(buildSessionSummaryFromDigests([]))).toBe(2);
    const one = buildSkeletonChange(
      { kind: "change", files: [{ path: "src/auth/login.ts", diff: LOGIN_DIFF }], promptRefs: [] },
      PAIR,
    );
    expect(sentences(buildSessionSummaryFromDigests([one.digest]))).toBe(2);
  });
});

describe("isStaleByHash", () => {
  it("dedupes identical id sets and flags new hashes", () => {
    expect(isStaleByHash(["c_aaa"], ["c_aaa"])).toBe(false);
    expect(isStaleByHash(["c_aaa"], ["c_aaa", "c_bbb"])).toBe(true);
    expect(isStaleByHash([], [])).toBe(false);
    expect(isStaleByHash(["c_aaa"], [])).toBe(false);
  });
});

describe("sessionBudget", () => {
  it("keeps small sessions whole and folds bigger ones harder", () => {
    expect(sessionBudget(0)).toBe(0);
    expect(sessionBudget(5)).toBe(5);
    expect(sessionBudget(8)).toBe(8);
    expect(sessionBudget(10)).toBe(10);
    expect(sessionBudget(24)).toBe(5);
    expect(sessionBudget(100)).toBe(10);
    expect(sessionBudget(1000)).toBe(24);
  });
});

describe("mergeSessionGroups", () => {
  function bigGroup(path: string, lines: number): ChangeGroup {
    const added = Array.from({ length: lines }, (_, i) => `+line${i}`).join("\n");
    return {
      kind: "change",
      files: [
        {
          path,
          diff: [
            `diff --git a/${path} b/${path}`,
            `--- a/${path}`,
            `+++ b/${path}`,
            "@@ -1 +1 @@",
            " same",
            added,
            "",
          ].join("\n"),
        },
      ],
      promptRefs: [],
      span: { prevOid: `p${path}`, nextOid: `n${path}` },
    };
  }

  it("returns small inputs untouched", () => {
    const groups = [bigGroup("b.ts", 3), bigGroup("a.ts", 10)];
    expect(mergeSessionGroups(groups)).toEqual(groups);
  });

  it("folds 24 groups to 4 kept plus small rollups with the biggest kept", () => {
    const groups = Array.from({ length: 24 }, (_, i) =>
      bigGroup(`src/f${String(i).padStart(2, "0")}.ts`, i + 1),
    );
    const merged = mergeSessionGroups(groups);
    // 20 folded files split into two 10-file rollups; nothing giant.
    expect(merged).toHaveLength(6);
    expect(merged[0]?.kind).toBe("small");
    expect(merged[0]?.rollup).toBe(true);
    expect(merged[0]?.rollupIndex).toBe(0);
    expect(merged[1]?.rollup).toBe(true);
    expect(merged[1]?.rollupIndex).toBe(1);
    expect(merged[0]?.files).toHaveLength(10);
    expect(merged[1]?.files).toHaveLength(10);
    // Biggest substantive groups survive (23, 22, 21, 20 lines).
    const kept = merged.slice(2).map((group) => group.files[0]?.path);
    expect(kept).toEqual(["src/f23.ts", "src/f22.ts", "src/f21.ts", "src/f20.ts"]);
    // Each rollup spans its own folded pairs in input order.
    expect(merged[0]?.span).toEqual({ prevOid: "psrc/f00.ts", nextOid: "nsrc/f09.ts" });
    expect(merged[1]?.span).toEqual({ prevOid: "psrc/f10.ts", nextOid: "nsrc/f19.ts" });
    // Rollups dedupe files and stay valid skeleton inputs.
    for (const rollup of merged.slice(0, 2)) {
      const skeleton = buildSkeletonChange(rollup as ChangeGroup, PAIR);
      expect(ChangeSchema.safeParse({ ...skeleton, version: 1 }).success).toBe(true);
    }
  });

  it("caps every emitted group at 10 files across areas", () => {
    const groups = [
      ...Array.from({ length: 14 }, (_, i) => bigGroup(`apps/a${i}.ts`, 30 + i)),
      ...Array.from({ length: 14 }, (_, i) => bigGroup(`docs/d${i}.md`, 1)),
    ];
    const merged = mergeSessionGroups(groups);
    for (const group of merged) {
      expect(group.files.length).toBeLessThanOrEqual(MAX_FILES_PER_CHANGE);
    }
    // Folded docs land in their own area chunk, not mixed with apps files.
    const rollups = merged.filter((group) => group.rollup === true);
    expect(rollups.length).toBeGreaterThan(0);
    for (const rollup of rollups) {
      const areas = new Set(rollup.files.map((file) => file.path.split("/")[0]));
      expect(areas.size).toBe(1);
    }
  });

  it("is deterministic under shuffle", () => {
    const groups = Array.from({ length: 30 }, (_, i) => bigGroup(`src/g${i}.ts`, (i * 7) % 20));
    const once = mergeSessionGroups(groups).map((g) => g.files.map((f) => f.path).join(","));
    const shuffled = [...groups].reverse();
    const twice = mergeSessionGroups(shuffled).map((g) => g.files.map((f) => f.path).join(","));
    expect([...once].sort()).toEqual([...twice].sort());
  });
});
