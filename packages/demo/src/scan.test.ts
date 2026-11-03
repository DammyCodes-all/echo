import { describe, expect, it } from "vitest";
import { scanBundleFiles, scanTextContent } from "./scan";

describe("demo scan", () => {
  it("passes redacted placeholders", () => {
    expect(scanTextContent("LEDGER_API_KEY=[REDACTED:env-assignment:a7b4]", [])).toEqual([]);
    expect(scanTextContent("token [REDACTED:api-key-prefix:9f2c] done", [])).toEqual([]);
  });

  it("fails closed on raw secrets with rule ids only", () => {
    expect(scanTextContent("LEDGER_API_KEY=hunter2hunter2", [])).toEqual(["env-assignment"]);
    const bare = scanTextContent("token sk-abcdefghij1234567890", []);
    expect(bare).toEqual(["api-key-prefix"]);
    expect(JSON.stringify(bare)).not.toContain("abcdefghij");
  });

  it("does not match code adjacent to a stripped placeholder", () => {
    // Regression: the bake failed on a redaction-test assertion shaped like
    // startsWith("OPENAI_API_KEY=<placeholder>")).toBe(true) — stripping the
    // placeholder to empty glued KEY=" to trailing code the rule then read
    // as a secret value. The placeholder proves that position redacted.
    expect(
      scanTextContent('x("OPENAI_API_KEY=[REDACTED:env-assignment:fe65]")).toBe(true);', []),
    ).toEqual([]);
    // Control: a real secret in the same shape still fails closed.
    expect(scanTextContent('x("OPENAI_API_KEY=hunter2hunter2")).toBe(true);', [])).toEqual([
      "env-assignment",
    ]);
  });

  it("honors explicitly allowed synthetic values", () => {
    expect(scanTextContent("token sk-SYNTHETIC_DEMO_0000 ok", ["sk-SYNTHETIC_DEMO_0000"])).toEqual(
      [],
    );
  });

  it("groups findings per file without content", () => {
    const findings = scanBundleFiles(
      [
        { label: "a.json", text: "Bearer abcdefghijklmnopqr and Bearer stuvwxyz01234567" },
        { label: "b.json", text: "nothing here" },
      ],
      [],
    );
    expect(findings).toEqual([{ file: "a.json", rule: "bearer-token", matches: 2 }]);
  });
});
