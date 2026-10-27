import { describe, expect, it } from "vitest";
import { parseExportDocument, reconcileExport, runRedactedExport } from "./export";

describe("parseExportDocument", () => {
  it("mints keys from stream identity and flags unknown schemas", () => {
    const parsed = parseExportDocument({
      export_schema_version: 1,
      events: [
        { kind: "record", envelope: { stream: { id: "s1" }, sequence: 3 }, derived: {} },
        { kind: "gap" },
        "broken",
      ],
      diagnostics: [],
    });
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.records.map((record) => record.key)).toEqual(["s1:3", "export-ordinal:1"]);
    expect(parsed.diagnostics).toContain("export_skipped_record");

    const unknown = parseExportDocument({ events: [] });
    expect(unknown.diagnostics).toContain("export_schema_unknown");

    const invalid = parseExportDocument(null);
    expect(invalid.diagnostics).toContain("export_invalid");
  });
});

describe("reconcileExport", () => {
  it("splits added, merged and conflicting keys without inventing content", () => {
    const result = reconcileExport(
      new Map([
        ["s1:3", "same"],
        ["s1:4", "live Revisions"],
      ]),
      [
        { key: "s1:3", hash: "same", raw: {} },
        { key: "s1:4", hash: "export Revisions", raw: {} },
        { key: "s1:9", hash: "new", raw: {} },
      ],
    );
    expect(result.mergedKeys).toEqual(["s1:3"]);
    expect(result.addedKeys).toEqual(["s1:9"]);
    expect(result.conflicts).toEqual([
      { key: "s1:4", liveHash: "live Revisions", exportHash: "export Revisions" },
    ]);
  });
});

describe("runRedactedExport", () => {
  it("reports a missing binary as unavailable instead of throwing", () => {
    const result = runRedactedExport("ses_missing", "muse-binary-that-does-not-exist");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic).toBe("export_unavailable");
  });
});
