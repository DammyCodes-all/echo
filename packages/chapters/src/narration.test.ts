import { describe, expect, it } from "vitest";
import type { ChangeGroup, DiffFile, SnapshotPair } from "./changes";
import {
  buildChangeNarrationMessages,
  CHANGE_NARRATION_PROMPT_VERSION,
  MAX_CHANGE_PROMPT_CHARS,
  MAX_DIFF_CHARS_PER_FILE,
  MAX_DIGEST_CHARS_PER_ITEM,
  MAX_EARLIER_DIGESTS,
  MAX_MOMENT_PROMPTS,
  MAX_PROMPT_CHARS_PER_ITEM,
  parseChangeDraft,
} from "./narration";

const PAIR: SnapshotPair = { prevOid: "a".repeat(40), nextOid: "b".repeat(40) };

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

function files(paths: string[]): DiffFile[] {
  return paths.map((path) => ({ path, diff: LOGIN_DIFF.replaceAll("src/auth/login.ts", path) }));
}

function group(kind: ChangeGroup["kind"], paths: string[], promptRefs: number[] = []): ChangeGroup {
  return { kind, files: files(paths), promptRefs };
}

function validDraft() {
  return {
    title: "Add project notes file",
    summary:
      "This change adds the project notes file. The new lines now carry the updated content for review.",
    before: ["Before this change, the notes file held the earlier form."],
    now: ["Now the file carries the updated version in place."],
    howItWorks: [
      "Change notes.txt: add the new lines.",
      "Keep the surrounding content as is.",
      "Review the new lines only.",
    ],
    headsUp: [],
    files: [{ path: "notes.txt", note: "Change notes.txt: updated." }],
    digest: Array.from({ length: 60 }, (_, i) => `token${i}`).join(" "),
  };
}

describe("buildChangeNarrationMessages", () => {
  it("states caps, shape, and the never-invent-files rule in the system prompt", () => {
    const { system } = buildChangeNarrationMessages({
      group: group("change", ["src/auth/login.ts"]),
      prompts: [],
      digests: [],
      pair: PAIR,
    });
    for (const line of [
      "1-8 words",
      "2-3 sentences",
      "1-2 non-empty strings",
      "3-5 non-empty steps",
      "0-3 items",
      "not_asked | watch_out | unfinished",
      "50-100 whitespace-separated tokens",
      "Never invent file names",
      "Write for someone who has never seen this codebase",
      "internal names unless you explain them in the same sentence",
      "describe behavior and outcomes, never function or hook swaps",
      "Do not include id, version, snapshotPair, or createdFrom",
    ]) {
      expect(system).toContain(line);
    }
  });

  it("renders head, files, diffs, prompts, and digests", () => {
    const { user, truncated } = buildChangeNarrationMessages({
      group: group("change", ["src/auth/login.ts"], [0]),
      prompts: ["please add login hardening"],
      digests: ["an earlier digest about routing changes here"],
      pair: PAIR,
    });
    expect(truncated).toBe(false);
    expect(user).toContain(`prompt_version: ${CHANGE_NARRATION_PROMPT_VERSION}`);
    expect(user).toContain(`${PAIR.prevOid}..${PAIR.nextOid}`);
    expect(user).toContain("group: change (1 file)");
    expect(user).toContain("- src/auth/login.ts");
    expect(user).toContain("=== src/auth/login.ts ===");
    expect(user).toContain("please add login hardening");
    expect(user).toContain("an earlier digest about routing changes here");
  });

  it("marks per-field truncation", () => {
    const { user, truncated } = buildChangeNarrationMessages({
      group: group("change", ["big.ts"]),
      prompts: [`p${"x".repeat(MAX_PROMPT_CHARS_PER_ITEM + 10)}`],
      digests: [`d${"y".repeat(MAX_DIGEST_CHARS_PER_ITEM + 10)}`],
      pair: PAIR,
    });
    expect(truncated).toBe(true);
    expect(user).toContain("…(+");
    expect(user).toContain("chars)");
    // The diff itself (LOGIN_DIFF, short) is untouched: only over-cap fields mark.
    expect(user).toContain("@@ -10,6 +10,12 @@");
  });

  it("hard-cuts over-cap diffs with a marker", () => {
    const big = `diff --git a/big.ts b/big.ts\n${"+line\n".repeat(MAX_DIFF_CHARS_PER_FILE + 500)}`;
    const { user, truncated } = buildChangeNarrationMessages({
      group: { kind: "change", files: [{ path: "big.ts", diff: big }], promptRefs: [] },
      prompts: [],
      digests: [],
      pair: PAIR,
    });
    expect(truncated).toBe(true);
    expect(user).toContain(`…(+${big.length - MAX_DIFF_CHARS_PER_FILE} chars)`);
  });

  it("caps moment prompts and earlier digests with counts", () => {
    const { user, truncated } = buildChangeNarrationMessages({
      group: group("change", ["src/auth/login.ts"]),
      prompts: Array.from({ length: MAX_MOMENT_PROMPTS + 2 }, (_, i) => `prompt ${i}`),
      digests: Array.from({ length: MAX_EARLIER_DIGESTS + 2 }, (_, i) => `digest ${i}`),
      pair: PAIR,
    });
    expect(truncated).toBe(true);
    expect(user).toContain("[10]");
    expect(user).not.toContain("prompt 10");
    expect(user).toContain("…(2 more prompts omitted over the per-group cap)");
    expect(user).toContain("…(2 more digests omitted over the per-group cap)");
  });

  it("drops digest blocks first over the whole-prompt cap", () => {
    // Every block stays under its per-field cap, but the total clears 30k:
    // diffs ~5.7k x3 + prompts ~1.9k x10 + digests ~1.1k x5.
    const bigDiff = (name: string) => `diff --git a/${name} b/${name}\n${"+x\n".repeat(1900)}`;
    const pad = (seed: string, size: number) => `${seed} ${"z".repeat(size)}`;
    const { user, truncated } = buildChangeNarrationMessages({
      group: {
        kind: "change",
        files: ["a.ts", "b.ts", "c.ts"].map((path) => ({ path, diff: bigDiff(path) })),
        promptRefs: [],
      },
      prompts: Array.from({ length: MAX_MOMENT_PROMPTS }, (_, i) => pad(`prompt${i}`, 1900)),
      digests: Array.from({ length: MAX_EARLIER_DIGESTS }, (_, i) => pad(`digest${i}`, 1100)),
      pair: PAIR,
    });
    expect(truncated).toBe(true);
    expect(user).toContain("omitted over the prompt cap");
    // Digest-first eviction: all digests go while the earliest prompts survive.
    expect(user).not.toContain("digest0");
    expect(user).toContain("prompt0");
  });

  it("hard-cuts when diffs alone exceed the whole-prompt cap", () => {
    const bigFiles = Array.from({ length: 6 }, (_, i) => ({
      path: `f${i}.ts`,
      diff: `diff --git a/f${i}.ts b/f${i}.ts\n${`+line${i}\n`.repeat(1100)}`,
    }));
    const { user, truncated } = buildChangeNarrationMessages({
      group: { kind: "change", files: bigFiles, promptRefs: [] },
      prompts: [],
      digests: [],
      pair: PAIR,
    });
    expect(truncated).toBe(true);
    expect(user).toContain("…(prompt cut over the whole-prompt cap)");
    expect(user.length).toBeLessThanOrEqual(MAX_CHANGE_PROMPT_CHARS + 200);
  });

  it("labels trivial groups for empty howItWorks", () => {
    const { user } = buildChangeNarrationMessages({
      group: group("small", ["docs/readme.md"]),
      prompts: [],
      digests: [],
      pair: PAIR,
    });
    expect(user).toContain("trivial");
    expect(user).toContain("set howItWorks to []");
  });

  it("labels substantive groups for 3-5 steps", () => {
    const { user } = buildChangeNarrationMessages({
      group: group("change", ["src/auth/login.ts"]),
      prompts: [],
      digests: [],
      pair: PAIR,
    });
    expect(user).toContain("substantive");
    expect(user).toContain("3-5 steps");
  });

  it("sorts files by path", () => {
    const { user } = buildChangeNarrationMessages({
      group: group("change", ["z-last.ts", "a-first.ts"]),
      prompts: [],
      digests: [],
      pair: PAIR,
    });
    expect(user.indexOf("=== a-first.ts ===")).toBeLessThan(user.indexOf("=== z-last.ts ==="));
  });

  it("renders the empty-prompts and empty-digests copy", () => {
    const { user } = buildChangeNarrationMessages({
      group: group("change", ["src/auth/login.ts"]),
      prompts: [],
      digests: [],
      pair: PAIR,
    });
    expect(user).toContain("(no linked prompts this moment)");
    expect(user).toContain("(no earlier digests yet)");
  });
});

describe("parseChangeDraft", () => {
  it("accepts a structurally valid draft", () => {
    const parsed = parseChangeDraft(validDraft());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.draft.title).toBe("Add project notes file");
  });

  it("accepts empty howItWorks and headsUp for trivial groups", () => {
    const parsed = parseChangeDraft({ ...validDraft(), howItWorks: [], headsUp: [] });
    expect(parsed.ok).toBe(true);
  });

  it("rejects non-objects without throwing", () => {
    for (const value of [undefined, null, "change", 42, []] as unknown[]) {
      expect(() => parseChangeDraft(value)).not.toThrow();
      expect(parseChangeDraft(value).ok).toBe(false);
    }
  });

  it("collects structural errors", () => {
    const parsed = parseChangeDraft({
      ...validDraft(),
      title: "",
      headsUp: [{ type: "risky", text: "nope" }],
      files: [],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.join(" ")).toContain("title");
      expect(parsed.errors.join(" ")).toContain("headsUp[0]");
      expect(parsed.errors.join(" ")).toContain("files");
    }
  });
});
