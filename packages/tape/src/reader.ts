import { readFileSync, statSync } from "node:fs";
import type { TapeEvent } from "@echo/contracts";
import { TapeEnvelopeSchema } from "@echo/contracts";

export interface TapeReadResult {
  events: TapeEvent[];
  truncatedTailBytes: number;
  oversizedLines: number;
  invalidLines: number;
  duplicateEvents: number;
}

const MAX_LINE_BYTES = 8 * 1024 * 1024;

export function readTape(path: string): TapeReadResult {
  const result: TapeReadResult = {
    events: [],
    truncatedTailBytes: 0,
    oversizedLines: 0,
    invalidLines: 0,
    duplicateEvents: 0,
  };

  const size = statSync(path).size;
  if (size === 0) return result;

  const content = readFileSync(path, "utf8");
  let lines = content.split("\n");
  const last = lines.pop();
  if (last !== undefined && last !== "") {
    result.truncatedTailBytes = Buffer.byteLength(last, "utf8");
  }
  lines = lines.filter((line) => line !== "");
  const seen = new Set<string>();

  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      result.oversizedLines++;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      result.invalidLines++;
      continue;
    }
    const event = TapeEnvelopeSchema.safeParse(parsed);
    if (!event.success) {
      result.invalidLines++;
      continue;
    }
    if (seen.has(event.data.event_id)) {
      result.duplicateEvents++;
      continue;
    }
    seen.add(event.data.event_id);
    result.events.push(event.data);
  }

  return result;
}
