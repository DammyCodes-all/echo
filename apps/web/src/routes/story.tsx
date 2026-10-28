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
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../api";
import { AskThreadPanel } from "../components/ask-thread-panel";
import { CheckOffer } from "../components/check-offer";
import { CheckPicture } from "../components/check-picture";
import { CheckRunner } from "../components/check-runner";
import { ScaffoldPage } from "../components/scaffold-page";
import { ClaimItem, type HistoryEntry, StoryCard } from "../components/story-card";
import { useEngagement } from "../hooks/use-engagement";

const CHECK_UNAVAILABLE = "Check unavailable (model off). Your session status is untouched.";

function checkMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Check failed.";
  return /unavailable/i.test(raw) ? CHECK_UNAVAILABLE : raw;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("404");
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

function looseEndNote(looseEnd: LooseEnd, cards: ChangeCard[]): string {
  if (looseEnd.cardId === null) return "No linked card.";
  const linked = cards.find((card) => card.id === looseEnd.cardId);
  return linked
    ? `Linked card: ${linked.headline}`
    : `Linked card ${looseEnd.cardId} is not in this story.`;
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
  return (
    <div>
      <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">{title}</p>
      {claims.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm">
          {claims.map((claim) => (
            <ClaimItem
              key={`${title}-${claim.text}`}
              claim={claim}
              forceUncertain={forceUncertain}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-dusk-muted">None recorded.</p>
      )}
    </div>
  );
}

function DetourItem({ detour }: { detour: Detour }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
      <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
        {detour.costReason.replace("_", " ")}
      </p>
      <p className="mt-2 text-dusk-body text-dusk-ink">{detour.headline}</p>
      {detour.claims.length > 0 ? (
        <ul className="mt-3 space-y-1 text-sm">
          {detour.claims.map((claim) => (
            <ClaimItem key={`${detour.id}-${claim.text}`} claim={claim} />
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-sm text-dusk-muted">The full dead-end tree:</p>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mt-1 text-sm text-dusk-muted underline underline-offset-4"
      >
        {open ? "Hide attempt nodes" : `Show ${detour.attemptIds.length} attempt nodes`}
      </button>
      {open ? (
        // attemptIds ARE the tree nodes: each id names one dead-end attempt.
        <ul className="mt-2 space-y-1 font-mono text-xs text-dusk-muted">
          {detour.attemptIds.map((attemptId) => (
            <li key={attemptId}>{attemptId}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function StoryPage() {
  const { sessionId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { track } = useEngagement(sessionId);

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
  const [askOpen, setAskOpen] = useState(false);
  const [askCard, setAskCard] = useState<{ id: string; headline: string } | null>(null);
  const [checkRunnerOpen, setCheckRunnerOpen] = useState(false);
  const [checkFocusId, setCheckFocusId] = useState<string | null>(null);
  const [checkFinished, setCheckFinished] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

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
        <div className="rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
          Loading story…
        </div>
      </ScaffoldPage>
    );
  }

  if (storyQuery.isError || story === undefined) {
    const notFound = isNotFound(storyQuery.error);
    return (
      <ScaffoldPage
        eyebrow="Session story"
        title="Story unavailable"
        description="The story for this session, in plain words."
      >
        <div className="rounded-dusk-card border border-dusk-fail/40 bg-dusk-fail-wash p-8 text-sm text-dusk-fail">
          <p>
            {notFound
              ? "Story not ready yet — the session may still be recording."
              : storyQuery.error instanceof Error
                ? storyQuery.error.message
                : "Could not load the story."}
          </p>
          {notFound ? (
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
  const observedCount = story.cards.filter((card) => card.verification === "observed").length;
  const sorted =
    sortMode === "risk"
      ? [...story.cards].sort((a, b) => a.rank - b.rank)
      : [...story.cards].sort((a, b) => a.sessionOrder - b.sessionOrder);
  const visible = showAll ? sorted : sorted.slice(0, 7);
  const hiddenCount = sorted.length - visible.length;

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
    setCheckBusy(true);
    setCheckError(null);
    try {
      const next = await api.generateChecksV2(sessionId);
      queryClient.setQueryData(["checks-v2", sessionId], next);
      setCheckFocusId(null);
      setCheckRunnerOpen(true);
    } catch (unknown) {
      setCheckError(checkMessage(unknown));
    } finally {
      setCheckBusy(false);
    }
  };

  const handleCheckMe = async (asked: { id: string; headline: string }) => {
    if (checkBusy) return;
    setCheckBusy(true);
    setCheckError(null);
    try {
      const next: ChecksV2Response = await api.checkMe(sessionId, asked.id);
      queryClient.setQueryData(["checks-v2", sessionId], next);
      setCheckFocusId(next.questions.find((question) => question.cardId === asked.id)?.id ?? null);
      setCheckRunnerOpen(true);
    } catch (unknown) {
      setCheckError(checkMessage(unknown));
    } finally {
      setCheckBusy(false);
    }
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
    <ScaffoldPage eyebrow="Session story" title={story.summary} description={story.summary}>
      {story.skeleton ? (
        <div className="rounded-dusk-card bg-dusk-pill px-6 py-3 text-sm text-dusk-accent-soft">
          Model unavailable — deterministic skeleton from the tape.
        </div>
      ) : null}

      <div className="space-y-8">
        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">Short version</h2>
          <p className="text-dusk-body text-dusk-ink">{story.summary}</p>
          {story.shortVersion.length > 0 ? (
            <ul className="space-y-1 text-sm">
              {story.shortVersion.map((claim) => (
                <ClaimItem key={`short-${claim.text}`} claim={claim} />
              ))}
            </ul>
          ) : null}
          <p className="font-mono text-xs text-dusk-muted">
            Verified: {observedCount} of {story.cards.length} cards observed
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">Ask vs result</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <AskGroup title="Asked" claims={story.askVsResult.asked} />
            <AskGroup title="Delivered" claims={story.askVsResult.delivered} />
            <AskGroup title="Extras" claims={story.askVsResult.extras} forceUncertain />
            <AskGroup title="Missing" claims={story.askVsResult.missing} forceUncertain />
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">What changed</h2>
          {story.routineSummary ? (
            <p className="text-sm text-dusk-muted">{story.routineSummary}</p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setSortMode("risk")}
              className={`rounded-dusk-code px-3 py-2 text-sm ${
                sortMode === "risk" ? "bg-dusk-ink text-white" : "bg-dusk-pill text-dusk-ink"
              }`}
            >
              Risk
            </button>
            <button
              type="button"
              onClick={() => setSortMode("session")}
              className={`rounded-dusk-code px-3 py-2 text-sm ${
                sortMode === "session" ? "bg-dusk-ink text-white" : "bg-dusk-pill text-dusk-ink"
              }`}
            >
              Session order
            </button>
          </div>
          {sorted.length === 0 ? (
            <div className="rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
              <p>No changes shipped in this session.</p>
              <p className="mt-1">No checks needed — there is nothing here to verify.</p>
            </div>
          ) : (
            <div className="space-y-4">
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
                  onCheck={handleCheckMe}
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

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">Detours</h2>
          {story.detours.length > 0 ? (
            <div className="space-y-4">
              {story.detours.map((detour) => (
                <DetourItem key={detour.id} detour={detour} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-dusk-muted">No detours recorded.</p>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold tracking-tight">Loose ends</h2>
          {story.looseEnds.length > 0 ? (
            <div className="space-y-4">
              {story.looseEnds.map((looseEnd) => (
                <div key={looseEnd.id} className="rounded-dusk-card bg-dusk-surface px-6 py-5">
                  <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
                    {looseEnd.kind.replace("_", " ")}
                  </p>
                  {looseEnd.claims.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-sm">
                      {looseEnd.claims.map((claim) => (
                        <ClaimItem key={`${looseEnd.id}-${claim.text}`} claim={claim} />
                      ))}
                    </ul>
                  ) : null}
                  <p className="mt-2 text-sm text-dusk-muted">
                    {looseEndNote(looseEnd, story.cards)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-dusk-muted">No loose ends recorded.</p>
          )}
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
          <section className="space-y-3">
            <h2 className="text-xl font-semibold tracking-tight">Understanding check</h2>
            <div className="rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
              No check needed for this session.
            </div>
          </section>
        ) : (
          <section className="space-y-3">
            <h2 className="text-xl font-semibold tracking-tight">Understanding check</h2>
            {checkError !== null ? <p className="text-sm text-dusk-fail">{checkError}</p> : null}
            {checksQuery.isPending ? (
              <p className="text-sm text-dusk-muted">Loading check…</p>
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
                onSkip={() => void handleSkipCheck()}
                onDone={handleRunnerDone}
              />
            ) : checksQuery.data.status === "skipped" ? (
              <div className="space-y-3 rounded-dusk-card bg-dusk-surface px-6 py-5">
                <p className="text-sm text-dusk-muted">Skipped — no pressure.</p>
                <button
                  type="button"
                  onClick={handleBackToInbox}
                  className="rounded-dusk-code bg-dusk-ink px-3 py-2 text-sm text-white"
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
                onSkip={() => void handleSkipCheck()}
                starting={checkBusy}
              />
            )}
          </section>
        )}
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
    </ScaffoldPage>
  );
}
