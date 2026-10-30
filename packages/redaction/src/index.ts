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
  let parsed: unknown;
  try {
    // Serialize first so unserializable inputs (BigInt, circular refs) still
    // refuse here, then work on the parsed tree: redacting inside real string
    // values and keys means regex matches can never span a JSON escape
    // boundary (e.g. a secret glued to `\"`), which used to consume the
    // backslash and emit unparseable JSON. Stringify of the scrubbed tree is
    // then always valid, so valid input never fails the scan.
    const serialized = JSON.stringify(value) ?? "null";
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("unserializable payload; refusing to store");
  }
  const findings: RedactionFinding[] = [];
  const scrub = (node: unknown): unknown => {
    if (typeof node === "string") {
      const result = redactText(node);
      findings.push(...result.findings);
      return result.value;
    }
    if (Array.isArray(node)) return node.map(scrub);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(node)) {
        const scrubbedKey = redactText(key);
        findings.push(...scrubbedKey.findings);
        out[scrubbedKey.value] = scrub(entry);
      }
      return out;
    }
    return node;
  };
  return { value: scrub(parsed), findings };
}
