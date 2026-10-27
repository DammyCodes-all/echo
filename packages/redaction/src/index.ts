export interface RedactionFinding {
  rule: string;
  placeholder: string;
}

export interface RedactionResult<T> {
  value: T;
  findings: RedactionFinding[];
}

const RULES: Array<{ id: string; pattern: RegExp }> = [
  {
    id: "env-assignment",
    pattern:
      /(\b[A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[=:]\s*["']?)([^\s"',;`]{8,})/g,
  },
  {
    id: "bearer-token",
    pattern: /(\bBearer\s+)([A-Za-z0-9._~+/=-]{16,})/g,
  },
  {
    id: "api-key-prefix",
    pattern:
      /()(\bsk-[A-Za-z0-9_-]{20,}\b|\bghp_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b)/g,
  },
];

function suffixFor(secret: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < secret.length; i++) {
    hash ^= secret.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 4);
}

export function redactText(text: string): RedactionResult<string> {
  const findings: RedactionFinding[] = [];
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (_match: string, prefix: string, secret: string) => {
      const placeholder = `[REDACTED:${rule.id}:${suffixFor(secret)}]`;
      findings.push({ rule: rule.id, placeholder });
      return prefix + placeholder;
    });
  }
  return { value: out, findings };
}

export function redactJson(value: unknown): RedactionResult<unknown> {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "null";
  } catch {
    throw new Error("unserializable payload; refusing to store");
  }
  const result = redactText(serialized);
  try {
    return { value: JSON.parse(result.value), findings: result.findings };
  } catch {
    // redaction must never mangle JSON into something unparseable; treat as failure
    throw new Error("redaction produced invalid JSON; refusing to store");
  }
}
