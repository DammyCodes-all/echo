import { describe, expect, it } from "vitest";
import { redactJson, redactText } from "./index";

describe("redactText", () => {
  it("redacts env-style assignments with a stable typed placeholder", () => {
    const withEquals = redactText("OPENAI_API_KEY=sk-test123456789012345678");
    expect(withEquals.value.startsWith("OPENAI_API_KEY=[REDACTED:env-assignment:")).toBe(true);
    expect(withEquals.value.endsWith("]")).toBe(true);
    expect(withEquals.findings[0]?.rule).toBe("env-assignment");

    const again = redactText("OPENAI_API_KEY=sk-test123456789012345678");
    expect(again.findings[0]?.placeholder).toBe(withEquals.findings[0]?.placeholder);

    const withColon = redactText('METAROUTER_TOKEN: "abcdefgh12345678"');
    expect(withColon.value).not.toContain("abcdefgh12345678");
    expect(withColon.findings[0]?.rule).toBe("env-assignment");
  });

  it("redacts bearer tokens and known key prefixes", () => {
    expect(redactText("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6").value).toContain(
      "[REDACTED:bearer-token:",
    );
    const gh = redactText("token ghp_0123456789abcdefghijklmnopqrst");
    expect(gh.value).toContain("[REDACTED:api-key-prefix:");
    expect(gh.findings[0]?.rule).toBe("api-key-prefix");
  });

  it("leaves git oids and ordinary code intact", () => {
    const text = "commit 853694aae8816094a0d875fee7ea26278dbf5d0f created file README.md";
    expect(redactText(text)).toEqual({ value: text, findings: [] });
  });
});

describe("redactJson escape boundaries", () => {
  it("survives a secret glued to a JSON escape (quoted assignment in code)", () => {
    // Regression: the scanner used to run on the serialized blob, so a secret
    // match could swallow the backslash of a nearby \" escape and emit
    // unparseable JSON. Real shape: repo diffs containing quoted KEY=... lines.
    const input = {
      text: 'writeFileSync(join(root, ".env.local"), "ECHO_TEST_LOAD_KEY=from-env-value-here");',
    };
    const result = redactJson(input);
    const value = result.value as { text: string };
    expect(value.text).not.toContain("from-env-value-here");
    expect(value.text).toContain("[REDACTED:env-assignment:");
    expect(() => JSON.stringify(result.value)).not.toThrow();
  });

  it("survives re-scanning an already-redacted placeholder inside quotes", () => {
    // Capture-time redaction leaves [REDACTED:...] placeholders on tape; the
    // story request re-scan must not choke when one sits next to an escape.
    const input = {
      text: 'writeFileSync(join(root, ".env.local"), "ECHO_TEST_LOAD_KEY=[REDACTED:env-assignment:365c]");',
    };
    const result = redactJson(input);
    expect(() => JSON.stringify(result.value)).not.toThrow();
    expect(JSON.stringify(result.value)).not.toContain("365c]");
  });

  it("round-trips lone surrogates from mid-emoji cap slices", () => {
    // cap() slices UTF-16, so a cut emoji leaves a lone surrogate. That never
    // broke the scan (JSON escapes it); pin the behavior so nobody "fixes"
    // cap() for this.
    const result = redactJson([{ content: "emoji slice \uD83D tail" }]);
    expect((result.value as Array<{ content: string }>)[0]?.content).toBe(
      "emoji slice \uD83D tail",
    );
  });
});

describe("redactJson", () => {
  it("scrubs secrets inside nested payloads and counts findings", () => {
    const result = redactJson({
      text: "use METAROUTER_TOKEN=paste-of-32-chars-xxxxx ok",
      nested: { auth: "Bearer eyJhbGciOiJIUzUxMiJ9.payload.sig" },
      commit: "853694aae8816094a0d875fee7ea26278dbf5d0f",
    });
    const value = result.value as Record<string, unknown>;
    expect(JSON.stringify(value)).not.toContain("paste-of-32-chars-xxxxx");
    expect(JSON.stringify(value)).not.toContain("eyJhbGciOiJIUzUxMiJ9");
    expect(value.commit).toBe("853694aae8816094a0d875fee7ea26278dbf5d0f");
    expect(result.findings.length).toBe(2);
  });

  it("round-trips clean payloads unchanged", () => {
    const input = { hello: "world", list: [1, 2, 3] };
    const result = redactJson(input);
    expect(result.value).toEqual(input);
    expect(result.findings).toEqual([]);
  });
});
