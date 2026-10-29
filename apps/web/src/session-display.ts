import { capStorySummary } from "@echo/contracts";

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

/**
 * Card display title: our model narration wins; when that didn't run
 * (skeleton fallback or nothing yet), the agent's own session title is the
 * default. The compacted skeleton text is last resort before the
 * recording/empty placeholders. Every content branch runs through the shared
 * headline cap so summaries stored before the cap still render as one short
 * sentence; the full text stays on the card hover title and the story page.
 */
export function sessionDisplayTitle(session: {
  summary: string | null;
  summarySkeleton: boolean;
  title: string | null;
  captureState: string;
}): string {
  if (session.summary && !session.summarySkeleton) return capStorySummary(session.summary);
  const agentTitle = session.title?.trim();
  if (agentTitle) return capStorySummary(agentTitle);
  if (session.summary)
    return capStorySummary(compactSessionSummary(session.summary) ?? session.summary);
  if (session.captureState === "recording") return "Still recording — story pending…";
  return "No summary";
}
