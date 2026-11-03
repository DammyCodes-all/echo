/**
 * Minimal answer markdown for ask responses: paragraphs, `*`/`-` and
 * `1.` lists, plus `[En]` source tokens that resolve against the served
 * evidence order. Anything unrecognized stays literal text. Content is
 * never dropped: an unknown token renders as-is rather than vanishing.
 */

export type AnswerSpan =
  | { kind: "text"; text: string }
  | { kind: "source"; token: string; position: number };

export type AnswerBlock =
  | { kind: "paragraph"; spans: AnswerSpan[] }
  | { kind: "list"; ordered: boolean; items: AnswerSpan[][] };

const BULLET = /^\s*[*\-•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const SOURCE_TOKEN = /\[E(\d+)\]/g;

function spansFor(line: string, positionOf: (token: string) => number | null): AnswerSpan[] {
  const spans: AnswerSpan[] = [];
  let last = 0;
  SOURCE_TOKEN.lastIndex = 0;
  let match = SOURCE_TOKEN.exec(line);
  while (match !== null) {
    if (match.index > last) spans.push({ kind: "text", text: line.slice(last, match.index) });
    const token = `E${match[1]}`;
    const position = positionOf(token);
    spans.push(
      position === null ? { kind: "text", text: match[0] } : { kind: "source", token, position },
    );
    last = match.index + match[0].length;
    match = SOURCE_TOKEN.exec(line);
  }
  if (last < line.length) spans.push({ kind: "text", text: line.slice(last) });
  // Merge adjacent text spans so unmatched tokens rejoin their sentence.
  const merged: AnswerSpan[] = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    if (span.kind === "text" && prev?.kind === "text") prev.text += span.text;
    else merged.push(span);
  }
  return merged;
}

export function parseAnswer(answer: string, evidenceIds: readonly string[]): AnswerBlock[] {
  const positionOf = (token: string): number | null => {
    const index = evidenceIds.indexOf(token);
    return index === -1 ? null : index + 1;
  };
  const blocks: AnswerBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: AnswerSpan[][] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const spans = spansFor(paragraph.join(" "), positionOf);
    if (spans.length > 0) blocks.push({ kind: "paragraph", spans });
    paragraph = [];
  };
  const flushList = () => {
    if (list !== null) {
      blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
      list = null;
    }
  };

  for (const raw of answer.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    const bullet = line.match(BULLET);
    const numbered = bullet === null ? line.match(NUMBERED) : null;
    if (bullet !== null || numbered !== null) {
      flushParagraph();
      const ordered = numbered !== null;
      const content = (bullet?.[1] ?? numbered?.[1] ?? "").trim();
      if (list === null || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(spansFor(content, positionOf));
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}
