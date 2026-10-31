import { describe, expect, it } from "vitest";
import {
  CHANGES_FILE_NAME,
  ChangeIdSchema,
  ChangeSchema,
  firstNotUnderstood,
  PROGRESS_FILE_NAME,
  ProgressSchema,
  REVIEW_READER_ARTIFACT_FILE_NAMES,
} from "./index";

function digest(words: number): string {
  return Array.from({ length: words }, (_, i) => `token${i}`).join(" ");
}

function minimalChange(overrides: Record<string, unknown> = {}) {
  return {
    id: "c_0123456789abcdef",
    version: 1,
    snapshotPair: { prevOid: "aaa", nextOid: "bbb" },
    title: "Retry failed billing writes once",
    summary: "The agent added a retry around billing writes. It fires once after a short delay.",
    before: ["Billing writes failed without a retry."],
    now: ["Billing writes retry once after a short delay."],
    howItWorks: ["The wrapper catches the write error.", "It waits briefly, then retries once."],
    headsUp: [{ type: "watch_out", text: "Retries can double-charge on timeouts." }],
    files: [{ path: "src/billing/retry.ts", note: "Adds the one-shot retry wrapper." }],
    digest: digest(60),
    createdFrom: { kind: "snapshot_pair", prevOid: "aaa", nextOid: "bbb" },
    ...overrides,
  };
}

describe("review-reader change contracts", () => {
  it("enforces the change id shape (c_ + 16 lowercase hex)", () => {
    expect(ChangeIdSchema.safeParse("c_0123456789abcdef").success).toBe(true);
    for (const bad of [
      "h_0123456789abcdef",
      "c_0123456789ABCDEF",
      "c_0123456789abcde",
      "c_0123456789abcdef0",
      "0123456789abcdef",
      "",
    ]) {
      expect(ChangeIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("parses a minimal valid change", () => {
    const parsed = ChangeSchema.parse(minimalChange());
    expect(parsed.id).toBe("c_0123456789abcdef");
    expect(parsed.version).toBe(1);
  });

  it("rejects versions below 1", () => {
    expect(ChangeSchema.safeParse(minimalChange({ version: 0 })).success).toBe(false);
    expect(ChangeSchema.safeParse(minimalChange({ version: 1.5 })).success).toBe(false);
  });

  it("caps the title at 8 words", () => {
    expect(ChangeSchema.safeParse(minimalChange({ title: "One two three" })).success).toBe(true);
    expect(
      ChangeSchema.safeParse(minimalChange({ title: "One two three four five six seven eight" }))
        .success,
    ).toBe(true);
    expect(
      ChangeSchema.safeParse(
        minimalChange({ title: "One two three four five six seven eight nine" }),
      ).success,
    ).toBe(false);
  });

  it("requires a 2-3 sentence summary", () => {
    expect(ChangeSchema.safeParse(minimalChange()).success).toBe(true);
    expect(
      ChangeSchema.safeParse(minimalChange({ summary: "Only one sentence here." })).success,
    ).toBe(false);
    expect(
      ChangeSchema.safeParse(
        minimalChange({ summary: "First sentence here. Second sentence here. Third one here." }),
      ).success,
    ).toBe(true);
    expect(
      ChangeSchema.safeParse(
        minimalChange({
          summary: "First. Second. Third. Fourth.",
        }),
      ).success,
    ).toBe(false);
  });

  it("bounds before/now to 1-2 entries and howItWorks to 0-5", () => {
    expect(ChangeSchema.safeParse(minimalChange({ before: [] })).success).toBe(false);
    expect(ChangeSchema.safeParse(minimalChange({ now: [] })).success).toBe(false);
    expect(ChangeSchema.safeParse(minimalChange({ before: ["a.", "b.", "c."] })).success).toBe(
      false,
    );
    expect(ChangeSchema.safeParse(minimalChange({ howItWorks: [] })).success).toBe(true);
    expect(
      ChangeSchema.safeParse(minimalChange({ howItWorks: ["1", "2", "3", "4", "5"] })).success,
    ).toBe(true);
    expect(
      ChangeSchema.safeParse(minimalChange({ howItWorks: ["1", "2", "3", "4", "5", "6"] })).success,
    ).toBe(false);
  });

  it("bounds headsUp to 3 typed items", () => {
    const item = (type: string) => ({ type, text: "note" });
    expect(
      ChangeSchema.safeParse(
        minimalChange({ headsUp: [item("not_asked"), item("watch_out"), item("unfinished")] }),
      ).success,
    ).toBe(true);
    expect(
      ChangeSchema.safeParse(
        minimalChange({
          headsUp: [item("watch_out"), item("watch_out"), item("watch_out"), item("watch_out")],
        }),
      ).success,
    ).toBe(false);
    expect(
      ChangeSchema.safeParse(minimalChange({ headsUp: [{ type: "risky", text: "note" }] })).success,
    ).toBe(false);
  });

  it("requires files with a one-line note each", () => {
    expect(ChangeSchema.safeParse(minimalChange({ files: [] })).success).toBe(false);
    expect(
      ChangeSchema.safeParse(minimalChange({ files: [{ path: "a.ts", note: "" }] })).success,
    ).toBe(false);
  });

  it("bounds the digest to 50-100 whitespace-separated tokens", () => {
    expect(ChangeSchema.safeParse(minimalChange({ digest: digest(50) })).success).toBe(true);
    expect(ChangeSchema.safeParse(minimalChange({ digest: digest(100) })).success).toBe(true);
    expect(ChangeSchema.safeParse(minimalChange({ digest: digest(49) })).success).toBe(false);
    expect(ChangeSchema.safeParse(minimalChange({ digest: digest(101) })).success).toBe(false);
  });

  it("accepts both createdFrom shapes", () => {
    expect(
      ChangeSchema.safeParse(
        minimalChange({ createdFrom: { kind: "tape_range", startSeq: 3, endSeq: 9 } }),
      ).success,
    ).toBe(true);
    expect(
      ChangeSchema.safeParse(
        minimalChange({ createdFrom: { kind: "tape_range", startSeq: -1, endSeq: 9 } }),
      ).success,
    ).toBe(false);
    expect(ChangeSchema.safeParse(minimalChange({ createdFrom: { kind: "other" } })).success).toBe(
      false,
    );
  });
});

describe("review-reader progress contracts", () => {
  it("parses progress keyed on (id, version)", () => {
    const parsed = ProgressSchema.parse({
      changeId: "c_0123456789abcdef",
      version: 2,
      state: "understood",
      updatedAt: "2026-10-31T00:00:00.000Z",
    });
    expect(parsed.version).toBe(2);
    expect(
      ProgressSchema.safeParse({
        changeId: "c_0123456789abcdef",
        version: 1,
        state: "done",
        updatedAt: "2026-10-31T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("resumes at the first not-understood change", () => {
    const a = "c_aaaaaaaaaaaaaaaa" as const;
    const b = "c_bbbbbbbbbbbbbbbb" as const;
    const c = "c_cccccccccccccccc" as const;
    expect(firstNotUnderstood([a, b, c], new Map())).toBe(a);
    expect(firstNotUnderstood([a, b, c], new Map([[a, { state: "understood" as const }]]))).toBe(b);
    // Skipped and viewed still count as not-understood.
    expect(
      firstNotUnderstood(
        [a, b, c],
        new Map([
          [a, { state: "understood" as const }],
          [b, { state: "skipped" as const }],
        ]),
      ),
    ).toBe(b);
    expect(
      firstNotUnderstood([a, b], {
        [a]: { state: "understood" as const },
        [b]: { state: "understood" as const },
      }),
    ).toBe(null);
    expect(firstNotUnderstood([], new Map())).toBe(null);
  });

  it("pins the per-session artifact file names", () => {
    expect(CHANGES_FILE_NAME).toBe("changes.json");
    expect(PROGRESS_FILE_NAME).toBe("progress.json");
    expect(REVIEW_READER_ARTIFACT_FILE_NAMES).toEqual({
      changes: "changes.json",
      progress: "progress.json",
    });
  });
});
