import { redactText } from "@echo/redaction";

export interface ScanFinding {
  file: string;
  rule: string;
  matches: number;
}

// Placeholders the redaction gate wrote are proof of stripping, not leaks.
const PLACEHOLDER_PATTERN = /\[REDACTED:[^\]\r\n]*\]/g;

/**
 * Rules tripped by text after approved content is removed. Content-free:
 * returns rule ids only, never the matched secrets.
 */
export function scanTextContent(text: string, allowedSecrets: string[]): string[] {
  let stripped = text.replace(PLACEHOLDER_PATTERN, "");
  for (const secret of allowedSecrets) {
    if (secret.length > 0) stripped = stripped.split(secret).join("");
  }
  return redactText(stripped).findings.map((finding) => finding.rule);
}

export function scanBundleFiles(
  files: Array<{ label: string; text: string }>,
  allowedSecrets: string[],
): ScanFinding[] {
  const out: ScanFinding[] = [];
  for (const file of files) {
    const counts = new Map<string, number>();
    for (const rule of scanTextContent(file.text, allowedSecrets)) {
      counts.set(rule, (counts.get(rule) ?? 0) + 1);
    }
    for (const [rule, matches] of counts) out.push({ file: file.label, rule, matches });
  }
  return out;
}
