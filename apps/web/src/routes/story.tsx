import type {
  AskEvidence,
  ChangeCard,
  ChecksV2Response,
  Detour,
  LooseEnd,
  ReviewHunk,
  SessionStory,
  StoryClaim,
} from "@echo/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api, StoryNotReadyError } from "../api";
import { AskThreadPanel } from "../components/ask-thread-panel";
import { CheckOffer } from "../components/check-offer";
import { CheckPicture } from "../components/check-picture";
import { CheckRunner } from "../components/check-runner";
import { ProjectNavPill } from "../components/project-nav-pill";
import { ScaffoldPage } from "../components/scaffold-page";
import { ClaimBody, ClaimItem, type HistoryEntry, StoryCard } from "../components/story-card";
import { VerificationPanel } from "../components/verification-panel";
import { useDemoMode } from "../hooks/use-demo-mode";
import { useEngagement } from "../hooks/use-engagement";
import { sessionDisplayTitle } from "../session-display";

const CHECK_UNAVAILABLE = "Check unavailable (model off). Your session status is untouched.";

function checkMessage(error: unknown): string {
  if ((error instanceof DOMException || error instanceof Error) && error.name === "TimeoutError") {
    return "Check timed out — the model is slow or unreachable. Try again.";
  }
  const raw = error instanceof Error ? error.message : "Check failed.";
  return /unavailable/i.test(raw) ? CHECK_UNAVAILABLE : raw;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("404");
}

function tabClass(active: boolean): string {
  const base =
    "rounded-dusk-code px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent";
  return active
    ? `${base} bg-dusk-accent font-semibold text-dusk-base`
    : `${base} bg-dusk-pill text-dusk-muted hover:text-dusk-ink`;
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    (typeof record.summary === "string" || record.summary === null) &&
    (typeof record.matchNote === "string" || record.matchNote === null) &&
    Array.isArray(record.sharedFiles) &&
    record.sharedFiles.every((file) => typeof file === "string")
  );
}

function toHistoryEntries(raw: unknown): HistoryEntry[] {
  if (Array.isArray(raw)) return raw.filter(isHistoryEntry);
  if (raw !== null && typeof raw === "object" && "entries" in raw) {
    const entries = (raw as { entries: unknown }).entries;
    if (Array.isArray(entries)) return entries.filter(isHistoryEntry);
  }
  return [];
}

function SubtitleLinks({ story }: { story: SessionStory }) {
  if (story.cards.length === 0) return <>No behavior changes — research or answers only.</>;
  const behavior = `${story.cards.length} behavior change${story.cards.length === 1 ? "" : "s"}`;
  const detour =
    story.detours.length > 0
      ? ` · ${story.detours.length} detour${story.detours.length === 1 ? "" : "s"}`
      : null;
  const loose =
    story.looseEnds.length > 0
      ? `${story.looseEnds.length} loose end${story.looseEnds.length === 1 ? "" : "s"}`
      : null;
  return (
    <>
      <a href="#what-changed" className="underline underline-offset-4 hover:text-dusk-ink">
        {behavior}
      </a>
      {detour}
      {loose ? (
        <>
          {" · "}
          <a href="#loose-ends" className="underline underline-offset-4 hover:text-dusk-ink">
            {loose}
          </a>
        </>
      ) : null}
    </>
  );
}

function groupLooseEndsByBehavior(
  looseEnds: LooseEnd[],
  cards: ChangeCard[],
): { card: ChangeCard | null; ends: LooseEnd[] }[] {
  const byCard = new Map<string | null, LooseEnd[]>();
  for (const end of looseEnds) {
    byCard.set(end.cardId, [...(byCard.get(end.cardId) ?? []), end]);
  }
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const groups: { card: ChangeCard | null; ends: LooseEnd[] }[] = [];
  let unlinked: LooseEnd[] | null = null;
  for (const [cardId, ends] of byCard) {
    if (cardId === null) {
      unlinked = ends;
      continue;
    }
    groups.push({ card: cardById.get(cardId) ?? null, ends });
  }
  if (unlinked) groups.push({ card: null, ends: unlinked });
  return groups;
}

function pairAskedDelivered(
  asked: StoryClaim[],
  delivered: StoryClaim[],
): { ask: StoryClaim; result: StoryClaim | null }[] {
  if (asked.length === delivered.length) {
    return asked.map((ask, index) => ({ ask, result: delivered[index] ?? null }));
  }
  const used = new Set<number>();
  return asked.map((ask) => {
    const match = delivered.findIndex(
      (candidate, index) =>
        !used.has(index) && candidate.factIds.some((id) => ask.factIds.includes(id)),
    );
    if (match === -1) return { ask, result: null };
    used.add(match);
    return { ask, result: delivered[match] ?? null };
  });
}

function AskRows({ asked, delivered }: { asked: StoryClaim[]; delivered: StoryClaim[] }) {
  if (asked.length === 0) return null;
  return (
    <div className="space-y-3">
      {pairAskedDelivered(asked, delivered).map(({ ask, result }) => (
        <div
          key={`ask-${ask.text}`}
          className="grid gap-1 text-sm sm:grid-cols-[1fr_auto_1fr] sm:items-start sm:gap-3"
        >
          <p>
            <ClaimBody claim={ask} />
          </p>
          <span aria-hidden className="hidden text-dusk-muted sm:inline">
            →
          </span>
          {result ? (
            <p>
              <ClaimBody claim={result} />
            </p>
          ) : (
            <p className="text-sm text-dusk-muted">Not delivered</p>
          )}
        </div>
      ))}
    </div>
  );
}

function normalizeClaimText(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function ShortVersionSection({ story }: { story: SessionStory }) {
  const asked = new Set(story.askVsResult.asked.map((claim) => normalizeClaimText(claim.text)));
  const delivered = story.shortVersion.filter((claim) => {
    const text = normalizeClaimText(claim.text);
    return text !== "" && !text.startsWith("user asked") && !asked.has(text);
  });
  useEffect(() => {
    if (
      import.meta.env.DEV &&
      story.generator.kind === "model" &&
      !story.skeleton &&
      story.shortVersion.length > 0 &&
      delivered.length === 0
    ) {
      console.debug(
        `[echo] hid Short version for ${story.sessionId}: ${story.shortVersion.length} prompt-like line(s) filtered`,
      );
    }
  }, [story, delivered.length]);
  if (delivered.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold tracking-tight">Short version</h2>
      <ul className="space-y-1 text-sm">
        {delivered.map((claim) => (
          <ClaimItem key={`short-${claim.text}`} claim={claim} />
        ))}
      </ul>
    </section>
  );
}

function AskGroup({
  title,
  claims,
  forceUncertain = false,
}: {
  title: string;
  claims: StoryClaim[];
  forceUncertain?: boolean;
}) {
  if (claims.length === 0) return null;
  return (
    <div>
      <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">{title}</p>
      <ul className="mt-2 space-y-1 text-sm">
        {claims.map((claim) => (
          <ClaimItem key={`${title}-${claim.text}`} claim={claim} forceUncertain={forceUncertain} />
        ))}
      </ul>
    </div>
  );
}

function LooseEndGroup({
  card,
  ends,
  onOpenCard,
}: {
  card: ChangeCard | null;
  ends: LooseEnd[];
  onOpenCard: (cardId: string) => void;
}) {
  const singleKind = new Set(ends.map((end) => end.kind)).size === 1 ? ends[0]?.kind : null;
  return (
    <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
      {card ? (
        <button
          type="button"
          onClick={() => onOpenCard(card.id)}
          className="block text-left text-dusk-body text-dusk-ink underline underline-offset-4"
        >
          {card.headline}
        </button>
      ) : (
        <p className="text-dusk-body text-dusk-ink">Not tied to one change</p>
      )}
      {singleKind ? (
        <p className="mt-1 font-mono text-xs uppercase tracking-widest text-dusk-muted">
          {singleKind}
        </p>
      ) : null}
      <div className="mt-2 space-y-3">
        {ends.map((end) => (
          <div key={end.id}>
            {singleKind ? null : (
              <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
                {end.kind}
              </p>
            )}
            {end.claims.length > 0 ? (
              <ul className="mt-1 space-y-1 text-sm">
                {end.claims.map((claim) => (
                  <ClaimItem key={`${end.id}-${claim.text}`} claim={claim} />
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function DetourItem({ detour }: { detour: Detour }) {
  const plainReason =
    detour.costReason === "repeated_attempt"
      ? "Repeated tries"
      : detour.costReason === "reverted"
        ? "Reverted"
        : "Side effect";
  const attemptNoun = detour.attemptIds.length === 1 ? "try" : "tries";
  return (
    <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
      <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">{plainReason}</p>
      <p className="mt-2 text-dusk-body text-dusk-ink">{detour.headline}</p>
      {detour.claims.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm">
          {detour.claims.map((claim) => (
            <ClaimItem key={`${detour.id}-${claim.text}`} claim={claim} />
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-sm text-dusk-muted">
        Tried and dropped after {detour.attemptIds.length} {attemptNoun} — nothing from{" "}
        {detour.attemptIds.length === 1 ? "it" : "these"} survived.
      </p>
    </div>
  );
}

export function StoryPage() {
  const { sessionId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { track } = useEngagement(sessionId);
  // Demo forbids check-me and skip (403): hide those affordances up front so
  // the visitor never taps a button that cannot work.
  const demoMode = useDemoMode();

  useEffect(() => {
    track("story_opened");
  }, [track]);

  const storyQuery = useQuery({
    queryKey: ["story", sessionId],
    queryFn: () => api.story(sessionId),
  });
  const reviewQuery = useQuery({
    queryKey: ["review", sessionId],
    queryFn: () => api.review(sessionId),
  });
  const historyQuery = useQuery({
    queryKey: ["history", sessionId],
    queryFn: () => api.sessionHistory(sessionId),
  });

  const [sortMode, setSortMode] = useState<"risk" | "session">("risk");
  const [showAll, setShowAll] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [askOpen, setAskOpen] = useState(false);
  const [askCard, setAskCard] = useState<{ id: string; headline: string } | null>(null);
  const [checkRunnerOpen, setCheckRunnerOpen] = useState(false);
  const [checkFocusId, setCheckFocusId] = useState<string | null>(null);
  const [checkFinished, setCheckFinished] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const checkAbortRef = useRef<AbortController | null>(null);
  const checkCancelRef = useRef(false);

  const storyForGate = storyQuery.data as unknown as SessionStory | undefined;
  const checksQuery = useQuery({
    queryKey: ["checks-v2", sessionId],
    queryFn: () => api.checksV2State(sessionId),
    // No cards means no check needed: skip the state fetch entirely.
    enabled: (storyForGate?.cards.length ?? 0) > 0,
  });
  const sessionQuery = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.session(sessionId),
  });

  const story = storyQuery.data as unknown as SessionStory | undefined;

  if (storyQuery.isPending) {
    return (
      <ScaffoldPage
        eyebrow="Session story"
        title="Loading story…"
        description="The story for this session, in plain words."
      >
        <div role="status" aria-label="Loading story" className="max-w-2xl space-y-8">
          <span className="sr-only">Loading story…</span>
          <div aria-hidden className="space-y-3 motion-safe:animate-pulse">
            <div className="h-8 w-3/4 rounded-dusk-code bg-dusk-pill" />
            <div className="h-4 w-full rounded-dusk-code bg-dusk-pill" />
            <div className="h-4 w-2/3 rounded-dusk-code bg-dusk-pill" />
          </div>
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              aria-hidden
              className="space-y-3 rounded-dusk-card bg-dusk-surface p-8 motion-safe:animate-pulse"
            >
              <div className="h-5 w-1/3 rounded-dusk-code bg-dusk-pill" />
              <div className="h-4 w-full rounded-dusk-code bg-dusk-pill" />
              <div className="h-4 w-5/6 rounded-dusk-code bg-dusk-pill" />
              <div className="h-4 w-4/6 rounded-dusk-code bg-dusk-pill" />
            </div>
          ))}
        </div>
      </ScaffoldPage>
    );
  }

  if (storyQuery.isError || story === undefined) {
    const notFound = isNotFound(storyQuery.error);
    const waiting = storyQuery.error instanceof StoryNotReadyError;
    return (
      <ScaffoldPage
        eyebrow="Session story"
        title={waiting ? "Session still active" : "Story unavailable"}
        description="The story for this session, in plain words."
      >
        <div className="rounded-dusk-card border border-dusk-fail/40 bg-dusk-fail-wash p-8 text-sm text-dusk-fail">
          <p>
            {waiting
              ? "This session hasn't gone quiet yet — its story generates a minute after the tape goes silent. Check back soon."
              : notFound
                ? "Story not ready yet — the session may still be recording."
                : storyQuery.error instanceof Error
                  ? storyQuery.error.message
                  : "Could not load the story."}
          </p>
          {notFound || waiting ? (
            <button
              type="button"
              onClick={() => {
                void storyQuery.refetch();
              }}
              className="mt-4 rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink"
            >
              Retry
            </button>
          ) : null}
        </div>
      </ScaffoldPage>
    );
  }

  const reviewHunks = new Map<string, ReviewHunk>(
    reviewQuery.data?.hunks.map((hunk): [string, ReviewHunk] => [hunk.id, hunk]) ?? [],
  );
  const historyEntries = toHistoryEntries(historyQuery.data);
  // Untested loose ends exist iff the session ran nothing, so one shared
  // notice replaces the per-card line. Filtered here (not in the artifact)
  // so Ask/citations keep the full data while the UI shows it once.
  const noPassingRun = story.looseEnds.some((end) => end.kind === "untested");
  const visibleLooseEnds = noPassingRun
    ? story.looseEnds.filter((end) => end.kind !== "untested")
    : story.looseEnds;
  const looseEndGroups = groupLooseEndsByBehavior(visibleLooseEnds, story.cards);
  const hasAskVsResult =
    story.askVsResult.asked.length +
      story.askVsResult.delivered.length +
      story.askVsResult.extras.length +
      story.askVsResult.missing.length >
    0;
  const sorted =
    sortMode === "risk"
      ? [...story.cards].sort((a, b) => a.rank - b.rank)
      : [...story.cards].sort((a, b) => a.sessionOrder - b.sessionOrder);
  // Destructive matches pin to the top in either sort mode; locally dismissed
  // flags fall back to their sorted position. Dismissal is session-local
  // state only — the backend has no waiver yet.
  const isDestructive = (card: ChangeCard): boolean =>
    card.riskReasons.some((reason) => reason.startsWith("destructive:"));
  const pinned = sorted.filter((card) => isDestructive(card) && !dismissedIds.has(card.id));
  const rest = sorted.filter((card) => !(isDestructive(card) && !dismissedIds.has(card.id)));
  const ordered = [...pinned, ...rest];
  const visible = showAll ? ordered : ordered.slice(0, 7);
  const hiddenCount = ordered.length - visible.length;
  const toggleDismissed = (cardId: string) => {
    setDismissedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  };
  const handleAsk = (asked: { id: string; headline: string }) => {
    track("ask_opened", asked.id);
    setAskCard(asked);
    setAskOpen(true);
  };

  const openCard = (cardId: string) => {
    setExpandedId(cardId);
    requestAnimationFrame(() => {
      document
        .getElementById(`card-${cardId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const handleStartCheck = async () => {
    if (checkBusy) return;
    const controller = new AbortController();
    checkAbortRef.current = controller;
    checkCancelRef.current = false;
    setCheckBusy(true);
    setCheckError(null);
    try {
      const next = await api.generateChecksV2(sessionId, controller.signal);
      queryClient.setQueryData(["checks-v2", sessionId], next);
      setCheckFocusId(null);
      setCheckRunnerOpen(true);
    } catch (unknown) {
      if (!checkCancelRef.current) setCheckError(checkMessage(unknown));
    } finally {
      checkAbortRef.current = null;
      setCheckBusy(false);
    }
  };

  const handleCheckMe = async (asked: { id: string; headline: string }) => {
    if (checkBusy) return;
    const controller = new AbortController();
    checkAbortRef.current = controller;
    checkCancelRef.current = false;
    setCheckBusy(true);
    setCheckError(null);
    try {
      const next: ChecksV2Response = await api.checkMe(sessionId, asked.id, controller.signal);
      queryClient.setQueryData(["checks-v2", sessionId], next);
      setCheckFocusId(next.questions.find((question) => question.cardId === asked.id)?.id ?? null);
      setCheckRunnerOpen(true);
    } catch (unknown) {
      if (!checkCancelRef.current) setCheckError(checkMessage(unknown));
    } finally {
      checkAbortRef.current = null;
      setCheckBusy(false);
    }
  };

  const handleCancelCheck = () => {
    checkCancelRef.current = true;
    checkAbortRef.current?.abort();
  };

  const handleSkipCheck = async () => {
    if (checkBusy) return;
    setCheckBusy(true);
    setCheckError(null);
    try {
      await api.skipChecksV2(sessionId);
      queryClient.setQueryData(["checks-v2", sessionId], (old: ChecksV2Response | undefined) =>
        old === undefined ? old : { ...old, status: "skipped" as const },
      );
      setCheckRunnerOpen(false);
    } catch (unknown) {
      setCheckError(checkMessage(unknown));
    } finally {
      setCheckBusy(false);
    }
  };

  const handleRunnerDone = () => {
    setCheckRunnerOpen(false);
    setCheckFinished(true);
    void queryClient.invalidateQueries({ queryKey: ["story", sessionId] });
  };

  const handlePanelCheck = () => {
    const state = checksQuery.data;
    if (state && (state.questions.length > 0 || state.status !== "offered")) {
      document.getElementById("understanding-check")?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    void handleStartCheck();
  };

  const handleBackToInbox = () => {
    const projectId = sessionQuery.data?.projectId;
    navigate(projectId ? `/projects/${projectId}` : "/projects");
  };

  const handleCitationClick = (citation: AskEvidence, messageCardId?: string | null) => {
    // Prefer the message's own card, then the first card touching the cited
    // file, then the card the question was asked about.
    const direct =
      messageCardId && sorted.some((card) => card.id === messageCardId) ? messageCardId : null;
    const byFile = citation.filePath
      ? (sorted.find((card) => card.touches.includes(citation.filePath as string))?.id ?? null)
      : null;
    const targetId = direct ?? byFile ?? askCard?.id ?? null;
    if (targetId === null) return;
    setExpandedId(targetId);
    requestAnimationFrame(() => {
      document
        .getElementById(`card-${targetId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  return (
    <ScaffoldPage
      eyebrow="Session story"
      title={sessionDisplayTitle({
        summary: story.summary,
        summarySkeleton: story.skeleton,
        title: sessionQuery.data?.title ?? null,
        captureState: sessionQuery.data?.captureState ?? "ready",
      })}
      description={<SubtitleLinks story={story} />}
    >
      {story.skeleton ? (
        <div className="max-w-2xl rounded-dusk-card bg-dusk-pill px-6 py-3 text-sm text-dusk-accent-soft">
          Model unavailable — deterministic skeleton from the tape.
        </div>
      ) : null}

      <div className="lg:hidden sticky top-0 z-10 -mx-4 border-b border-dusk-hairline bg-dusk-base/95 px-4 py-3 backdrop-blur">
        <VerificationPanel
          compact
          counts={story.verifiedCounts}
          hasLooseEnds={story.looseEnds.length > 0 || story.blindSpots.length > 0}
          onStartCheck={handlePanelCheck}
          starting={checkBusy}
        />
      </div>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-8">
        <div className="min-w-0 max-w-2xl space-y-8">
          {<ShortVersionSection story={story} />}

          {hasAskVsResult ? (
            <section className="space-y-3">
              <h2 className="text-xl font-semibold tracking-tight">Ask vs result</h2>
              {story.askVsResult.asked.length > 0 ? (
                <AskRows asked={story.askVsResult.asked} delivered={story.askVsResult.delivered} />
              ) : (
                <AskGroup title="Delivered" claims={story.askVsResult.delivered} />
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <AskGroup title="Extras" claims={story.askVsResult.extras} forceUncertain />
                <AskGroup title="Missing" claims={story.askVsResult.missing} forceUncertain />
              </div>
            </section>
          ) : null}

          <section id="what-changed" className="scroll-mt-8 space-y-3">
            <h2 className="text-xl font-semibold tracking-tight">What changed</h2>
            {story.routineSummary ? (
              <p className="text-sm text-dusk-muted">{story.routineSummary}</p>
            ) : null}
            {sorted.length > 0 ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSortMode("risk")}
                  className={tabClass(sortMode === "risk")}
                >
                  Risk
                </button>
                <button
                  type="button"
                  onClick={() => setSortMode("session")}
                  className={tabClass(sortMode === "session")}
                >
                  Session order
                </button>
              </div>
            ) : null}
            {sorted.length === 0 ? (
              <div className="rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
                <p>No changes shipped in this session.</p>
                <p className="mt-1">No checks needed — there is nothing here to verify.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {noPassingRun ? (
                  <p className="text-sm text-dusk-muted">
                    No passing run observed in this session.
                  </p>
                ) : null}
                {visible.map((card) => (
                  <StoryCard
                    key={card.id}
                    card={card}
                    reviewHunks={reviewHunks}
                    historyEntries={historyEntries}
                    expanded={expandedId === card.id}
                    onToggle={() => setExpandedId(expandedId === card.id ? null : card.id)}
                    onTrack={track}
                    onAsk={handleAsk}
                    onCheck={demoMode ? undefined : handleCheckMe}
                    destructive={isDestructive(card)}
                    dismissed={dismissedIds.has(card.id)}
                    onDismiss={() => toggleDismissed(card.id)}
                  />
                ))}
                {hiddenCount > 0 && !showAll ? (
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink"
                  >
                    {hiddenCount} more changes
                  </button>
                ) : null}
              </div>
            )}
          </section>

          {story.detours.length > 0 ? (
            <section className="space-y-3">
              <h2 className="text-xl font-semibold tracking-tight">Detours</h2>
              <div className="space-y-4">
                {story.detours.map((detour) => (
                  <DetourItem key={detour.id} detour={detour} />
                ))}
              </div>
            </section>
          ) : null}

          {visibleLooseEnds.length > 0 || story.blindSpots.length > 0 ? (
            <section id="loose-ends" className="scroll-mt-8 space-y-3">
              <h2 className="text-xl font-semibold tracking-tight">Loose ends</h2>
              {looseEndGroups.length > 0 ? (
                <div className="space-y-4">
                  {looseEndGroups.map((group) => (
                    <LooseEndGroup
                      key={group.card?.id ?? "session"}
                      card={group.card}
                      ends={group.ends}
                      onOpenCard={openCard}
                    />
                  ))}
                </div>
              ) : null}
              {story.blindSpots.length > 0 ? (
                <div className="rounded-dusk-card border border-dusk-hairline-strong bg-dusk-surface px-6 py-5">
                  <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
                    Echo couldn&apos;t see
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-dusk-muted">
                    {story.blindSpots.map((spot) => (
                      <li key={spot}>{spot}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : null}

          {story.gaps.length > 0 ? (
            <section className="space-y-3">
              <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
                <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
                  What Echo couldn&apos;t verify
                </p>
                <ul className="mt-2 space-y-1 font-mono text-xs text-dusk-muted">
                  {story.gaps.map((gap) => (
                    <li key={gap}>Echo couldn&apos;t verify: {gap}</li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}

          {story.cards.length === 0 ? (
            <section id="understanding-check" className="scroll-mt-8 space-y-3">
              <h2 className="text-xl font-semibold tracking-tight">Understanding check</h2>
              <div className="rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
                No check needed for this session.
              </div>
            </section>
          ) : (
            <section id="understanding-check" className="scroll-mt-8 space-y-3">
              <h2 className="text-xl font-semibold tracking-tight">Understanding check</h2>
              {checkError !== null ? <p className="text-sm text-dusk-fail">{checkError}</p> : null}
              {checksQuery.isPending ? (
                <div
                  role="status"
                  aria-label="Loading check"
                  className="space-y-3 rounded-dusk-card bg-dusk-surface px-6 py-5"
                >
                  <span className="sr-only">Loading check…</span>
                  <div aria-hidden className="space-y-3 motion-safe:animate-pulse">
                    <div className="h-4 w-1/3 rounded-dusk-code bg-dusk-pill" />
                    <div className="h-5 w-3/4 rounded-dusk-code bg-dusk-pill" />
                    <div className="h-9 w-full rounded-dusk-code bg-dusk-pill" />
                    <div className="h-9 w-full rounded-dusk-code bg-dusk-pill" />
                    <div className="h-9 w-5/6 rounded-dusk-code bg-dusk-pill" />
                  </div>
                </div>
              ) : checksQuery.isError ? (
                <div className="rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
                  <p>Could not load the check.</p>
                  <button
                    type="button"
                    onClick={() => {
                      void checksQuery.refetch();
                    }}
                    className="mt-4 rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink"
                  >
                    Retry
                  </button>
                </div>
              ) : checksQuery.data === undefined ? null : checkRunnerOpen ? (
                <CheckRunner
                  sessionId={sessionId}
                  state={checksQuery.data}
                  focusQuestionId={checkFocusId}
                  onUpdate={(next) => queryClient.setQueryData(["checks-v2", sessionId], next)}
                  onSkip={demoMode ? undefined : () => void handleSkipCheck()}
                  onDone={handleRunnerDone}
                />
              ) : checksQuery.data.status === "skipped" ? (
                <div className="space-y-3 rounded-dusk-card bg-dusk-surface px-6 py-5">
                  <p className="text-sm text-dusk-muted">Skipped — no pressure.</p>
                  <button
                    type="button"
                    onClick={handleBackToInbox}
                    className="rounded-dusk-pill bg-dusk-accent px-5 py-2.5 text-sm font-semibold text-dusk-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent"
                  >
                    Done — back to inbox
                  </button>
                </div>
              ) : checksQuery.data.status === "completed" || checkFinished ? (
                <CheckPicture
                  cards={story.cards}
                  picture={checksQuery.data.picture}
                  onOpenCard={openCard}
                  onDone={handleBackToInbox}
                />
              ) : (
                <CheckOffer
                  hasHighRisk={story.cards.some((card) => card.highRisk)}
                  questionCount={
                    checksQuery.data.questions.length > 0 ? checksQuery.data.questions.length : null
                  }
                  onStart={() => void handleStartCheck()}
                  onSkip={demoMode ? undefined : () => void handleSkipCheck()}
                  onCancel={handleCancelCheck}
                  starting={checkBusy}
                />
              )}
            </section>
          )}
        </div>
        <aside className="mt-8 hidden lg:block lg:sticky lg:top-6 lg:self-start">
          <VerificationPanel
            counts={story.verifiedCounts}
            hasLooseEnds={story.looseEnds.length > 0 || story.blindSpots.length > 0}
            onStartCheck={handlePanelCheck}
            starting={checkBusy}
          />
        </aside>
      </div>
      {askOpen ? (
        <AskThreadPanel
          sessionId={sessionId}
          card={askCard}
          onClearCard={() => setAskCard(null)}
          onCitationClick={handleCitationClick}
          onClose={() => setAskOpen(false)}
        />
      ) : null}
      {sessionQuery.data?.projectId ? (
        <ProjectNavPill projectId={sessionQuery.data.projectId} active={-1} />
      ) : null}
    </ScaffoldPage>
  );
}
