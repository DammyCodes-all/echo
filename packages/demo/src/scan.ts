import { redactText } from "@echo/redaction";

export interface ScanFinding {
  file: string;
  rule: string;
  matches: number;
}

// Placeholders the redaction gate wrote are proof of stripping, not leaks.
const PLACEHOLDER_PATTERN = /\[REDACTED:[^\]\r\n]*\]/g;

// A presence-check echo ("KEY: missing") asserts the secret is absent, so it
// is proof of no leak the same way a placeholder is. Only the exact status
// word is neutralized: any 8+ char value still trips the rule. The rule's
// value class counts JSON escape backslashes, which is how the 7-letter word
// "missing" plus a trailing backslash reached the 8-char minimum.
const ABSENT_PATTERN =
  /\b([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*:\s*)missing\b/gi;

/**
 * Rules tripped by text after approved content is removed. Content-free:
 * returns rule ids only, never the matched secrets.
 */
export function scanTextContent(text: string, allowedSecrets: string[]): string[] {
  // Placeholders stand in for already-redacted values, so they read as empty
  // (not absent): stripping to "" glued KEY=" to trailing code the rules
  // then matched as a secret. The quotes break adjacency on both sides.
  let stripped = text.replace(PLACEHOLDER_PATTERN, '""');
  stripped = stripped.replace(ABSENT_PATTERN, '$1""');
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
