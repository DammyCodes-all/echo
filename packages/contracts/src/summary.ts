/**
 * Session-summary headline bound. Triage rows carry a one-line plain summary
 * (spec §landing), so the narration prompt asks for at most
 * STORY_SUMMARY_MAX_SENTENCES short sentences within STORY_SUMMARY_MAX_CHARS
 * characters, and capStorySummary enforces the same bound deterministically:
 * the server caps before persisting (finalize + carried-over titles) and the
 * web caps at display time for already-stored long summaries. Cuts fall on
 * sentence then word boundaries with an ellipsis — never mid-word — and the
 * full story stays one click away, so no diagnostic is recorded.
 */
export const STORY_SUMMARY_MAX_SENTENCES = 1;
export const STORY_SUMMARY_MAX_CHARS = 140;

/**
 * Sentence ends need whitespace plus an uppercase/digit start ahead and a
 * lowercase/digit behind, so filenames (`notes.txt`), versions (`1.3`) and
 * initials (`U.S.`) never split. Sentences ending in all-caps stay joined —
 * the character cap still bounds them.
 */
function splitSentences(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  const endMark = /[.!?]\s+(?=[A-Z0-9"“])/g;
  let match = endMark.exec(text);
  while (match) {
    const before = text[match.index - 1];
    if (before !== undefined && /[a-z0-9]/.test(before)) {
      parts.push(text.slice(start, match.index + 1));
      start = match.index + 1;
    }
    match = endMark.exec(text);
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

export function capStorySummary(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return text;
  const joined = splitSentences(flat).slice(0, STORY_SUMMARY_MAX_SENTENCES).join(" ");
  const headline = joined === "" ? flat : joined;
  if (headline.length <= STORY_SUMMARY_MAX_CHARS) return headline;
  const cut = headline.slice(0, STORY_SUMMARY_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace <= 0) return `${headline.slice(0, STORY_SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
  const words = cut.slice(0, lastSpace).replace(/[.,;:!?\s]+$/, "");
  if (words === "") return `${headline.slice(0, STORY_SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
  return `${words}…`;
}
