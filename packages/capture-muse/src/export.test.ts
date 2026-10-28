import { describe, expect, it } from "vitest";
import {
  classifyExportFailure,
  getMuseVersion,
  parseExportDocument,
  reconcileExport,
  runRedactedExport,
} from "./export";

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
  it("merges on shared keys and surfaces export-only keys without inventing content", () => {
    const result = reconcileExport(new Set(["s1:3", "s1:4"]), [
      { key: "s1:3", hash: "anything", raw: {} },
      { key: "s1:4", hash: "anything-else", raw: {} },
      { key: "s1:9", hash: "new", raw: {} },
    ]);
    expect(result.mergedKeys).toEqual(["s1:3", "s1:4"]);
    expect(result.addedKeys).toEqual(["s1:9"]);
  });
});

describe("runRedactedExport", () => {
  it("reports a missing binary as unavailable instead of throwing", () => {
    const result = runRedactedExport("ses_missing", "muse-binary-that-does-not-exist");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic).toBe("export_unavailable");
  });
});

describe("getMuseVersion", () => {
  it("returns trimmed stdout and null on failure", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "echo-muse-version-"));
    const ok = join(dir, "muse-ok.sh");
    writeFileSync(ok, "#!/bin/sh\necho '  Muse Code 1.4.13  '\n", { mode: 0o755 });
    expect(getMuseVersion(ok)).toBe("Muse Code 1.4.13");
    const fail = join(dir, "muse-fail.sh");
    writeFileSync(fail, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    expect(getMuseVersion(fail)).toBeNull();
    expect(getMuseVersion("/nonexistent/muse-binary-xyz")).toBeNull();
  });
});

describe("classifyExportFailure", () => {
  it("latches off only on a missing binary, retries timeouts and crashes", () => {
    expect(classifyExportFailure(Object.assign(new Error("spawn"), { code: "ENOENT" }))).toBe(
      "export_unavailable",
    );
    // Verified against node: timeouts surface as status null + ETIMEDOUT.
    expect(classifyExportFailure(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))).toBe(
      "export_failed",
    );
    expect(classifyExportFailure(new Error("boom"))).toBe("export_failed");
    expect(classifyExportFailure(undefined)).toBe("export_failed");
    expect(classifyExportFailure(null)).toBe("export_failed");
  });
});
