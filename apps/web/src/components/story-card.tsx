import type {
  ChangeCard,
  EngagementKind,
  ReviewHunk,
  StoryClaim,
  VerificationBadge,
} from "@echo/contracts";
import { useEffect, useRef, useState } from "react";

export type HistoryEntry = {
  sessionId: string;
  summary: string | null;
  matchNote: string | null;
  sharedFiles: string[];
};

type StoryCardProps = {
  card: ChangeCard;
  reviewHunks: Map<string, ReviewHunk>;
  historyEntries: HistoryEntry[];
  expanded: boolean;
  onToggle: () => void;
  onTrack: (kind: EngagementKind, cardId?: string | null) => void;
  onAsk: (card: { id: string; headline: string }) => void;
  onCheck?: (card: { id: string; headline: string }) => void;
  destructive: boolean;
  dismissed: boolean;
  onDismiss: () => void;
};

export const VERIFICATION_BADGE: Record<
  VerificationBadge,
  { className: string; title: string; label: string }
> = {
  observed: {
    className: "bg-dusk-pass-wash text-dusk-pass",
    title: "Observed — the tape shows this change happened.",
    label: "Observed",
  },
  partly_observed: {
    className: "bg-dusk-accent-wash text-dusk-accent-soft",
    title: "Partly observed — only some of this change is on the tape.",
    label: "Partly observed",
  },
  agent_stated: {
    className: "bg-dusk-peach-wash text-dusk-peach",
    title: "Agent-stated — the agent said this; the tape does not confirm it.",
    label: "Agent-stated",
  },
  nothing: {
    className: "bg-dusk-track text-dusk-muted",
    title: "Nothing observed — no tape evidence for this change.",
    label: "Nothing observed",
  },
};

export function ClaimBody({
  claim,
  forceUncertain = false,
}: {
  claim: StoryClaim;
  forceUncertain?: boolean;
}) {
  const uncertain = forceUncertain || claim.label === "uncertain";
  return (
    <>
      <span className={uncertain ? "text-dusk-muted" : "text-dusk-ink"}>{claim.text}</span>
      {claim.label === "agent_stated" ? (
        <span className="ml-2 rounded-dusk-code bg-dusk-peach-wash px-1.5 py-0.5 font-mono text-[10px] text-dusk-peach">
          agent-stated
        </span>
      ) : null}
      {uncertain ? (
        <span className="ml-2 rounded-dusk-code bg-dusk-track px-1.5 py-0.5 font-mono text-[10px] text-dusk-muted">
          uncertain
        </span>
      ) : null}
    </>
  );
}

export function ClaimItem({
  claim,
  forceUncertain = false,
}: {
  claim: StoryClaim;
  forceUncertain?: boolean;
}) {
  const uncertain = forceUncertain || claim.label === "uncertain";
  return (
    <li className={uncertain ? "text-dusk-muted" : "text-dusk-ink"}>
      <ClaimBody claim={claim} forceUncertain={forceUncertain} />
    </li>
  );
}

/**
 * Path-soup headlines read like file lists, not behavior. When the stored
 * headline names two paths (or echoes the skeleton shape) and the card
 * carries a why-line, show the why-line as the title — full headline stays
 * on hover. Pure presentational fallback; artifact data untouched.
 */
export function displayHeadline(card: Pick<ChangeCard, "headline" | "why">): string {
  const headline = card.headline;
  const pathHits = headline.match(/[\w./-]+\.\w+/g) ?? [];
  const looksLikeList =
    pathHits.length >= 2 || /^(Prompts, changes in|Prompts,|No verified)/i.test(headline);
  const fallback = card.why[0]?.text.trim();
  if (looksLikeList && fallback) {
    const words = fallback.split(/\s+/);
    return words.length > 14 ? `${words.slice(0, 14).join(" ")}…` : fallback;
  }
  return headline;
}

export function StoryCard({
  card,
  reviewHunks,
  historyEntries,
  expanded,
  onToggle,
  onTrack,
  onAsk,
  onCheck,
  destructive,
  dismissed,
  onDismiss,
}: StoryCardProps) {
  const [showCode, setShowCode] = useState(false);
  const rootRef = useRef<HTMLElement | null>(null);
  const seenRef = useRef(false);
  const trackRef = useRef(onTrack);
  trackRef.current = onTrack;

  // card_seen fires once per card after ~1s continuously visible.
  useEffect(() => {
    const node = rootRef.current;
    if (node === null || seenRef.current) return;
    let timer: number | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          if (timer === null) {
            timer = window.setTimeout(() => {
              seenRef.current = true;
              trackRef.current("card_seen", card.id);
              observer.disconnect();
            }, 1000);
          }
        } else if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [card.id]);

  const toggleExpanded = () => {
    if (!expanded) onTrack("card_expanded", card.id);
    onToggle();
  };

  const toggleCode = () => {
    if (!showCode) onTrack("code_shown", card.id);
    setShowCode(!showCode);
  };

  const badge = VERIFICATION_BADGE[card.verification];
  // riskReasons is flag reasons plus "rewrite: ..." notes (see rollUpRisk in
  // @echo/story). Flags render only beside the High risk flag; rewrite notes
  // are neutral evidence shown on any card that carries them.
  const rewriteNotes = card.riskReasons.filter((reason) => reason.startsWith("rewrite:"));
  const destructiveReasons = card.riskReasons.filter((reason) => reason.startsWith("destructive:"));
  // Pinned cards lead with the destructive match; other flag reasons stay
  // beside the High risk flag, dismissed ones drop out, rewrite notes stay
  // neutral. onDismiss toggles the dismissed state (dismiss and undo share it).
  const isPinned = destructive && !dismissed;
  const failReasons = card.riskReasons.filter(
    (reason) =>
      !reason.startsWith("rewrite:") &&
      !(isPinned && reason.startsWith("destructive:")) &&
      !(dismissed && reason.startsWith("destructive:")),
  );
  const related = historyEntries.filter((entry) =>
    entry.sharedFiles.some((file) => card.touches.includes(file)),
  );
  // Closed-card files repeat the headline when it is already path soup;
  // open-card "What it touches" keeps the full list.
  const headlineHidesPaths = displayHeadline(card) !== card.headline;
  const shownTouches = headlineHidesPaths ? [] : card.touches.slice(0, 4);
  const hiddenTouchCount = headlineHidesPaths ? 0 : card.touches.length - shownTouches.length;

  return (
    <article
      ref={rootRef}
      id={`card-${card.id}`}
      className={`rounded-dusk-card px-6 py-5 ${
        destructive && !dismissed
          ? "border border-dusk-fail/40 bg-dusk-fail-wash/40"
          : "bg-dusk-surface"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex flex-wrap items-center gap-2">
          <span
            title={badge.title}
            className={`shrink-0 rounded-dusk-code px-2.5 py-1 text-xs font-semibold ${badge.className}`}
          >
            {badge.label}
          </span>
          {card.highRisk ? (
            <span
              title="High risk — the tape shows a blast-radius flag on this change."
              className="shrink-0 rounded-dusk-code bg-dusk-fail-wash px-2.5 py-1 text-xs font-semibold text-dusk-fail"
            >
              High risk
            </span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={toggleExpanded}
          className="text-sm text-dusk-muted underline underline-offset-4"
        >
          {expanded ? "Close" : "Open"}
        </button>
      </div>
      <button
        type="button"
        onClick={toggleExpanded}
        className="mt-2 block text-left text-dusk-body text-dusk-ink"
        title={card.headline}
      >
        {displayHeadline(card)}
      </button>
      {shownTouches.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {shownTouches.map((path) => (
            <span
              key={path}
              className="rounded-dusk-code bg-dusk-pill px-2 py-0.5 font-mono text-xs text-dusk-accent-soft"
            >
              {path}
            </span>
          ))}
          {hiddenTouchCount > 0 ? (
            <span className="font-mono text-xs text-dusk-muted">+{hiddenTouchCount} more</span>
          ) : null}
        </div>
      ) : null}
      {card.why.length > 0 ? (
        <p className="mt-2 text-sm text-dusk-muted">{card.why[0]?.text}</p>
      ) : null}
      {isPinned ? (
        <div className="mt-2 space-y-1">
          {destructiveReasons.map((reason) => (
            <p key={reason} className="text-sm font-semibold text-dusk-fail">
              {reason}
            </p>
          ))}
          <button
            type="button"
            onClick={onDismiss}
            className="text-sm text-dusk-muted underline underline-offset-4"
          >
            Dismiss as false positive
          </button>
        </div>
      ) : null}
      {dismissed ? (
        <p className="mt-1 text-sm text-dusk-muted">
          Flag dismissed as false positive.{" "}
          <button type="button" onClick={onDismiss} className="underline underline-offset-4">
            Undo
          </button>
        </p>
      ) : null}
      {failReasons.map((reason) => (
        <p key={reason} className="mt-1 text-sm text-dusk-fail">
          {reason}
        </p>
      ))}
      {rewriteNotes.map((reason) => (
        <p key={reason} className="mt-1 text-sm text-dusk-muted">
          {reason}
        </p>
      ))}

      {expanded ? (
        <div className="mt-4 space-y-4 border-t border-dusk-hairline pt-4">
          {card.before.length > 0 || card.now.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {card.before.length > 0 ? (
                <div>
                  <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
                    Before
                  </p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {card.before.map((claim) => (
                      <ClaimItem key={`${card.id}-before-${claim.text}`} claim={claim} />
                    ))}
                  </ul>
                </div>
              ) : null}
              {card.now.length > 0 ? (
                <div>
                  <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">Now</p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {card.now.map((claim) => (
                      <ClaimItem key={`${card.id}-now-${claim.text}`} claim={claim} />
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">Why</p>
            {card.why.length > 0 ? (
              <ul className="mt-2 space-y-1 text-sm">
                {card.why.map((claim) => (
                  <ClaimItem key={`${card.id}-why-${claim.text}`} claim={claim} />
                ))}
              </ul>
            ) : null}
            <blockquote className="mt-2 border-l-2 border-dusk-hairline-strong pl-3">
              {card.moment.ts ? (
                <p className="font-mono text-[10px] text-dusk-muted">{card.moment.ts}</p>
              ) : null}
              <p className="mt-1 text-sm text-dusk-ink">{card.moment.excerpt}</p>
              {card.moment.eventId ? (
                <p className="mt-1 font-mono text-[10px] text-dusk-muted">{card.moment.eventId}</p>
              ) : null}
            </blockquote>
            {/* No tape page exists, so this inline slice IS the moment view. */}
          </div>

          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
              What checked it
            </p>
            {card.checkedBy.length > 0 ? (
              <ul className="mt-2 space-y-1 text-sm">
                {card.checkedBy.map((claim) => (
                  <ClaimItem key={`${card.id}-checked-${claim.text}`} claim={claim} />
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-dusk-muted">Nothing observed checking this.</p>
            )}
          </div>

          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
              What it touches
            </p>
            {card.touches.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1">
                {card.touches.map((path) => (
                  <span
                    key={path}
                    className="rounded-dusk-code bg-dusk-pill px-2 py-0.5 font-mono text-xs text-dusk-accent-soft"
                  >
                    {path}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-dusk-muted">No files touched.</p>
            )}
          </div>

          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
              Earlier sessions
            </p>
            {related.length > 0 ? (
              <div className="mt-2">
                <p className="text-sm text-dusk-ink">Seen in {related.length} earlier session(s)</p>
                <ul className="mt-2 space-y-2">
                  {related.map((entry) => (
                    <li
                      key={entry.sessionId}
                      className="rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm"
                    >
                      <p className="font-mono text-[10px] text-dusk-muted">{entry.sessionId}</p>
                      <p className="mt-1 text-dusk-ink">{entry.summary ?? "No summary."}</p>
                      {entry.matchNote ? (
                        <p className="mt-1 text-dusk-muted">
                          Echo&apos;s guess: {entry.matchNote}
                          <span className="ml-2 rounded-dusk-code bg-dusk-track px-1.5 py-0.5 font-mono text-[10px]">
                            uncertain
                          </span>
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-2 text-sm text-dusk-muted">
                No earlier sessions touched these files.
              </p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onAsk({ id: card.id, headline: card.headline })}
              className="rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink"
            >
              Ask why about this
            </button>
            {/* Check-me enables with the checks v2 offer below; Ask stays as-is. */}
            {onCheck ? (
              <button
                type="button"
                onClick={() => onCheck({ id: card.id, headline: card.headline })}
                className="rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink"
              >
                Check me on this
              </button>
            ) : (
              <button
                type="button"
                disabled
                title="Arrives with checks v2 (later phase)"
                className="rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-muted disabled:opacity-40"
              >
                Check me on this
              </button>
            )}
            <button
              type="button"
              onClick={toggleCode}
              className="rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink"
            >
              {showCode ? "Hide the code" : "Show the code"}
            </button>
          </div>

          {showCode ? (
            <div className="space-y-2">
              {card.constituentHunkIds.map((hunkId) => {
                const patch = reviewHunks.get(hunkId)?.patch;
                return (
                  <div key={hunkId}>
                    <p className="font-mono text-[10px] text-dusk-muted">{hunkId}</p>
                    {patch ? (
                      <pre className="mt-1 overflow-auto rounded-dusk-code bg-dusk-pill p-3 font-mono text-xs text-dusk-ink">
                        {patch}
                      </pre>
                    ) : (
                      <p className="mt-1 text-sm text-dusk-muted">
                        No captured diff for this part.
                      </p>
                    )}
                  </div>
                );
              })}
              {card.constituentActionIds.map((actionId) => (
                <div key={actionId}>
                  <p className="font-mono text-[10px] text-dusk-muted">{actionId}</p>
                  <p className="mt-1 text-sm text-dusk-muted">
                    Consequential action — no file diff.
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
