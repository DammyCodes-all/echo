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
