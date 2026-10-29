const SKELETON_CHANGES_PREFIX = "Prompts, changes in ";

/**
 * Skeleton summaries list up to five tape paths (`buildSkeletonStory` in
 * `@echo/story`); on a card that reads as path soup, and every card starts
 * the same way. Compact the known skeleton shape to its first path — the
 * full text stays on the hover title — and leave model prose untouched.
 * Paths never contain commas; the "and other files" overflow is filtered.
 */
export function compactSessionSummary(summary: string | null): string | null {
  if (summary === null || !summary.startsWith(SKELETON_CHANGES_PREFIX)) return summary;
  const list = summary.slice(SKELETON_CHANGES_PREFIX.length).replace(/\.\s*$/, "");
  const [first, ...rest] = list
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "" && part !== "and other files");
  if (first === undefined) return summary;
  return rest.length === 0 ? `Prompts · changes in ${first}` : `Prompts · changes in ${first}…`;
}
