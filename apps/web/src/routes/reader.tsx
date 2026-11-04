import type { Change, ChangeId, ChecksV2Response, ProgressState } from "@echo/contracts";
import { firstNotUnderstood } from "@echo/contracts";
import { GitCompareArrowsIcon } from "@hugeicons/core-free-icons";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api, ChangesNotReadyError } from "../api";
import { summarizeChangeChecks } from "../checks-summary";
import { CaughtUp } from "../components/caught-up";
import { ChangeCard, type ChangeConnection } from "../components/change-card";
import { CheckGateModal } from "../components/check-gate-modal";
import { CheckRunner } from "../components/check-runner";
import { ProgressTape } from "../components/progress-tape";
import { ReaderRail } from "../components/reader-rail";
import { ScaffoldPage } from "../components/scaffold-page";
import { IMMUTABLE_STALE_TIME, prefetchCode, queryKeys } from "../query";

const PRIMARY =
  "rounded-dusk-pill bg-dusk-accent px-5 py-2.5 text-sm font-semibold text-dusk-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent disabled:opacity-40";
const QUIET = "text-sm text-dusk-muted underline underline-offset-4 disabled:opacity-40";
const GHOST =
  "rounded-dusk-pill border border-dusk-hairline-strong px-4 py-2 text-sm text-dusk-muted transition-colors hover:border-dusk-muted hover:text-dusk-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent disabled:opacity-40";

/** Progress map, keyed on (id, version) so regen never resets it. Server-owned. */
type ReaderProgress = Record<string, { state: ProgressState; updatedAt: string }>;

function progressKey(change: Pick<Change, "id" | "version">): string {
  return `${change.id}@v${change.version}`;
}

/** Resume is the first not-understood change; past-the-end means caught up. */
function resumeIndexFor(changes: readonly Change[], progress: ReaderProgress): number {
  const keys = changes.map((change) => progressKey(change));
  const key = firstNotUnderstood(keys as ChangeId[], progress);
  if (key === null) return changes.length;
  const index = keys.indexOf(key);
  return index === -1 ? changes.length : index;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("404");
}

function checkMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Check failed.";
  if (/timed out|timeout/i.test(raw)) {
    return "Check timed out — the model is slow or unreachable. Try again.";
  }
  if (/unavailable|model off/i.test(raw)) {
    return "Check unavailable (model off). Your session status is untouched.";
  }
  if (/unknown card|no story|no check needed/i.test(raw)) {
    return "There's nothing to check here yet.";
  }
  return raw;
}

export function ReaderPage() {
  const { sessionId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const changesQuery = useQuery({
    queryKey: queryKeys.changes(sessionId),
    queryFn: () => api.changes(sessionId),
    // Switching sessions keeps the old list on screen while the new one
    // loads instead of flashing the full-page skeleton.
    placeholderData: keepPreviousData,
  });

  // Header owns project/session names; changes own the body. Separate
  // queries so a slow session row never blocks the change list.
  const sessionQuery = useQuery({
    queryKey: queryKeys.session(sessionId),
    queryFn: () => api.session(sessionId),
    retry: false,
    placeholderData: keepPreviousData,
  });
  const projectId = sessionQuery.data?.projectId ?? "";
  const projectQuery = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.project(projectId),
    enabled: projectId.length > 0,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const headerTitle = sessionQuery.data?.title?.trim() || `Session ${sessionId.slice(0, 8)}`;
  const projectName = projectQuery.data?.name?.trim() || "Project";
  const headerCrumb = {
    backTo: "/projects",
    backLabel: "Projects",
    trail:
      projectId.length > 0
        ? [{ label: projectName, to: `/projects/${encodeURIComponent(projectId)}/overview` }]
        : undefined,
    titleIcon: GitCompareArrowsIcon,
    // The session name stays small and quiet: the change title below is the
    // biggest thing on screen.
    quietTitle: true,
    // Shimmer until the row lands: never flash fallback text, and never swap
    // mid-read (isPending is only true with no data, not on refetch).
    titleLoading: sessionQuery.isPending,
  };

  const changes = changesQuery.data?.changes ?? [];
  const summary = changesQuery.data?.summary ?? "";
  const isLive = changesQuery.data?.isLive === true;

  // Server rows are the base; optimistic local marks overlay until refetch.
  const [localMarks, setLocalMarks] = useState<ReaderProgress>({});
  const progress: ReaderProgress = {};
  for (const row of changesQuery.data?.progress ?? []) {
    progress[`${row.changeId}@v${row.version}`] = {
      state: row.state,
      updatedAt: row.updatedAt,
    };
  }
  for (const [key, entry] of Object.entries(localMarks)) progress[key] = entry;

  const [currentIndex, setCurrentIndex] = useState<number | null>(null);
  const [showSummary, setShowSummary] = useState(false);

  // Checks v2 runner state, shared by the per-change and caught-up offers.
  const [checksState, setChecksState] = useState<ChecksV2Response | null>(null);
  const [checkFocusId, setCheckFocusId] = useState<string | null>(null);
  const [checkOpen, setCheckOpen] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  // Transition gate: "Got it" parks here and opens a blocking check modal
  // instead of advancing. Skip in the modal still marks understood.
  const [gate, setGate] = useState<{ changeId: string; title: string; target: number } | null>(
    null,
  );
  const [gateLoading, setGateLoading] = useState(false);

  // Null until the reader picks a slot: resume at the first not-understood
  // change once data lands, then hold the position across refetches.
  const viewIndex = currentIndex ?? resumeIndexFor(changes, progress);

  const mark = (change: Change, state: ProgressState) => {
    const key = progressKey(change);
    const entry = { state, updatedAt: new Date().toISOString() };
    setLocalMarks((prev) => (prev[key]?.state === state ? prev : { ...prev, [key]: entry }));
    // Fire-and-forget: the tape already shows the optimistic mark; the
    // refetch reconciles with the stored row.
    void api
      .recordProgress(sessionId, { changeId: change.id, version: change.version, state })
      .catch(() => null)
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.changes(sessionId) });
      });
  };

  const jump = (index: number) => {
    setShowSummary(false);
    setCurrentIndex(Math.max(0, Math.min(index, changes.length)));
  };

  const atEnd = viewIndex >= changes.length;
  const current = atEnd ? null : (changes[viewIndex] ?? null);
  // No diffs means no chapters, no tape, no checks: a dedicated empty state
  // owns this screen instead of the caught-up copy claiming completeness.
  const isEmpty = changes.length === 0;
  const stillRecording = sessionQuery.data?.captureState === "recording";
  const landedState = current === null ? undefined : progress[progressKey(current)]?.state;

  // Landing on a change counts as viewed; understood/skipped are never reset.
  useEffect(() => {
    if (current === null || landedState !== undefined) return;
    mark(current, "viewed");
  });

  // Diff for the change on screen, served from shadow git on demand.
  // Keyed by change id; the id guard drops stale data mid-transition.
  // Shadow-git diffs are immutable, so a viewed change never refetches.
  const codeQuery = useQuery({
    queryKey: queryKeys.code(sessionId, current?.id ?? ""),
    queryFn: () => api.changeCode(sessionId, current?.id ?? ""),
    enabled: current !== null,
    retry: false,
    staleTime: IMMUTABLE_STALE_TIME,
  });
  const code = codeQuery.data?.changeId === current?.id ? codeQuery.data : null;

  // Stored check state for the inline per-change result line. The runner's
  // live state wins once a check runs this visit.
  const storedChecksQuery = useQuery({
    queryKey: queryKeys.checks(sessionId),
    queryFn: () => api.checksV2State(sessionId),
    retry: false,
  });
  const checksView = checksState ?? storedChecksQuery.data ?? null;
  const checkResult =
    current === null || checksView === null
      ? null
      : summarizeChangeChecks(checksView.questions, checksView.attempts, current.id);

  const previous = !atEnd && viewIndex > 0 ? (changes[viewIndex - 1] ?? null) : null;
  const next = !atEnd && viewIndex < changes.length - 1 ? (changes[viewIndex + 1] ?? null) : null;
  const skipped = changes.filter((change) => progress[progressKey(change)]?.state === "skipped");
  const neverOpened = changes.filter((change) => progress[progressKey(change)] === undefined).length;

  // The thread lives in the rail's Ask tab; the tab state lives here so
  // the action row and wrap-up can flip to it.
  const [railTab, setRailTab] = useState<"changes" | "ask">("changes");

  // Gate modal bookkeeping: only this change's questions block Continue.
  // Other questions may ride along in the runner, but they never gate.
  const gateAnsweredIds =
    checksState === null
      ? new Set<string>()
      : new Set(checksState.attempts.map((attempt) => attempt.questionId));
  const gateQuestions =
    gate === null || checksState === null
      ? []
      : checksState.questions.filter((question) => question.cardId === gate.changeId);
  const gateDone =
    gateQuestions.length > 0 && gateQuestions.every((question) => gateAnsweredIds.has(question.id));

  // Prefetch the next change's diff while this one is being read, so
  // opening Code or stepping forward never waits on shadow git.
  useEffect(() => {
    if (next === null) return;
    prefetchCode(queryClient, sessionId, next.id);
  }, [queryClient, sessionId, next]);
  // Same-file neighbors in session order, nearest each way. Pure overlap
  // from the served list — no backend needed.
  const currentPaths = current === null ? null : new Set(current.files.map((file) => file.path));
  const nearestShared = (from: number, step: 1 | -1): Change | null => {
    if (currentPaths === null) return null;
    for (let index = from; index >= 0 && index < changes.length; index += step) {
      const candidate = changes[index];
      if (candidate === undefined) continue;
      if (candidate.files.some((file) => currentPaths.has(file.path))) return candidate;
    }
    return null;
  };
  const earlierConnection = current === null ? null : nearestShared(viewIndex - 1, -1);
  const changeConnections: ChangeConnection[] =
    earlierConnection === null
      ? []
      : [
          {
            id: earlierConnection.id,
            title: earlierConnection.title,
            direction: "earlier" as const,
          },
        ];
  const handleJumpToChange = (id: string) => {
    const index = changes.findIndex((candidate) => candidate.id === id);
    if (index !== -1) jump(index);
  };

  const handleDone = () => {
    navigate("/projects");
  };

  const handleStartCheck = async () => {
    if (checkBusy) return;
    setCheckBusy(true);
    setCheckError(null);
    try {
      const next = await api.generateChecksV2(sessionId);
      setChecksState(next);
      setCheckFocusId(null);
      setCheckOpen(true);
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
      setChecksState((old) => (old === null ? old : { ...old, status: "skipped" as const }));
      setCheckOpen(false);
    } catch (unknown) {
      setCheckError(checkMessage(unknown));
    } finally {
      setCheckBusy(false);
    }
  };

  const handleRunnerDone = () => {
    setCheckOpen(false);
  };

  // "Got it" parks on a gate instead of advancing: fetch this change's
  // check and block behind the modal. Fail open — a check that cannot
  // load never traps the reader. Already-answered changes pass through.
  const handleGotIt = () => {
    if (current === null || gate !== null) return;
    if (
      checkResult !== null &&
      checkResult.total > 0 &&
      checkResult.answered >= checkResult.total
    ) {
      mark(current, "understood");
      jump(viewIndex + 1);
      return;
    }
    const snapshot = { changeId: current.id, title: current.title, target: viewIndex + 1 };
    setGate(snapshot);
    setGateLoading(true);
    setCheckError(null);
    void api
      .checkMe(sessionId, current.id)
      .then((nextState) => {
        setChecksState(nextState);
        setCheckFocusId(
          nextState.questions.find((question) => question.cardId === current.id)?.id ?? null,
        );
      })
      .catch((unknown) => {
        setCheckError(checkMessage(unknown));
      })
      .finally(() => {
        setGateLoading(false);
      });
  };

  // Both Continue and Skip mark understood: the reader already said got it,
  // the modal only decides whether a check answer is recorded first.
  const resolveGate = () => {
    if (gate === null) return;
    const change = changes.find((candidate) => candidate.id === gate.changeId) ?? null;
    const target = gate.target;
    setGate(null);
    if (change !== null) mark(change, "understood");
    jump(target);
  };

  if (changesQuery.isPending) {
    return (
      <ScaffoldPage
        eyebrow="Session review"
        title={headerTitle}
        description="Walk through what changed, one change at a time."
        breadcrumb={headerCrumb}
      >
        <div role="status" aria-label="Loading changes" className="mx-auto w-full space-y-6">
          <span className="sr-only">Loading changes…</span>
          <div aria-hidden className="motion-safe:animate-pulse">
            <div className="flex items-center gap-3">
              <div className="flex flex-1 items-center gap-1.5">
                {["a", "b", "c", "d", "e"].map((key) => (
                  <div key={key} className="h-1.5 flex-1 rounded-full bg-dusk-track" />
                ))}
              </div>
              <div className="h-4 w-24 shrink-0 rounded-dusk-code bg-dusk-pill" />
            </div>
          </div>
          <div
            aria-hidden
            className="grid gap-8 motion-safe:animate-pulse lg:grid-cols-[minmax(0,1fr)_360px]"
          >
            <div className="min-w-0 space-y-6">
              <div>
                <div className="h-9 w-2/3 rounded-dusk-code bg-dusk-pill" />
                <div className="mt-1.5 h-4 w-1/2 rounded-dusk-code bg-dusk-pill" />
                <div className="mt-3 flex gap-2">
                  <div className="h-8 w-44 rounded-dusk-code bg-dusk-pill" />
                  <div className="h-8 w-56 rounded-dusk-code bg-dusk-pill" />
                </div>
                <div className="mt-3 space-y-2">
                  <div className="h-4 w-full rounded-dusk-code bg-dusk-pill" />
                  <div className="h-4 w-5/6 rounded-dusk-code bg-dusk-pill" />
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {["before", "now"].map((key) => (
                  <div
                    key={key}
                    className="rounded-dusk-code border border-dusk-hairline bg-dusk-surface px-4 py-3"
                  >
                    <div className="h-3 w-16 rounded-dusk-code bg-dusk-pill" />
                    <div className="mt-2 space-y-2">
                      <div className="h-4 w-full rounded-dusk-code bg-dusk-pill" />
                      <div className="h-4 w-4/5 rounded-dusk-code bg-dusk-pill" />
                    </div>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <div className="h-3 w-14 rounded-dusk-code bg-dusk-pill" />
                <div className="h-4 w-3/4 rounded-dusk-code bg-dusk-pill" />
                <div className="h-4 w-2/3 rounded-dusk-code bg-dusk-pill" />
              </div>
              <div className="flex items-center gap-2 py-3">
                <div className="h-3 w-3 rounded-dusk-code bg-dusk-pill" />
                <div className="h-3 w-12 rounded-dusk-code bg-dusk-pill" />
              </div>
              <div aria-hidden className="h-32 lg:h-20" />
            </div>
            <aside className="space-y-4">
              <div className="flex gap-4 border-b border-dusk-hairline pb-2">
                <div className="h-3 w-16 rounded-dusk-code bg-dusk-pill" />
                <div className="h-3 w-10 rounded-dusk-code bg-dusk-pill" />
              </div>
              <div>
                <div className="space-y-1">
                  {["r1", "r2", "r3", "r4", "r5"].map((key) => (
                    <div key={key} className="h-9 rounded-dusk-code bg-dusk-pill/50" />
                  ))}
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between gap-2">
                  <div className="h-3 w-28 rounded-dusk-code bg-dusk-pill" />
                  <div className="h-3 w-10 rounded-dusk-code bg-dusk-pill" />
                </div>
                <div className="mt-2 space-y-2">
                  {["g1", "g2", "g3"].map((key) => (
                    <div key={key} className="h-6 rounded-dusk-code bg-dusk-pill/50" />
                  ))}
                </div>
              </div>
            </aside>
          </div>
          <div
            aria-hidden
            className="fixed inset-x-0 bottom-0 z-20 border-t border-dusk-hairline bg-dusk-base motion-safe:animate-pulse lg:left-[max(1.5rem,calc((100vw-80rem)/2+1.5rem))] lg:right-[max(26rem,calc((100vw-80rem)/2+26rem))]"
          >
            <div
              aria-hidden
              className="pointer-events-none absolute -top-12 right-0 left-0 h-12 bg-gradient-to-b from-dusk-base/0 to-dusk-base"
            />
            <div className="px-6 pb-4 pt-4 lg:px-0">
              <div className="flex items-center justify-between gap-3">
                <div className="h-9 w-20 rounded-dusk-pill bg-dusk-pill" />
                <div className="flex items-center gap-3">
                  <div className="h-9 w-40 rounded-dusk-pill bg-dusk-pill" />
                  <div className="h-10 w-44 rounded-dusk-pill bg-dusk-pill" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </ScaffoldPage>
    );
  }

  if (changesQuery.isError || changesQuery.data === undefined) {
    const waiting = changesQuery.error instanceof ChangesNotReadyError;
    const notFound = isNotFound(changesQuery.error);
    const errorMessage = changesQuery.error instanceof Error ? changesQuery.error.message : null;
    // A rejected fetch means the daemon was unreachable (restarting after
    // a file change, or not running) — a connection problem, not an
    // unready session. Name it as such and offer a retry.
    const offline =
      !waiting &&
      !notFound &&
      errorMessage !== null &&
      /failed to fetch|networkerror|load failed|network request failed/i.test(errorMessage);
    return (
      <ScaffoldPage
        eyebrow="Session review"
        title={waiting || notFound || offline ? headerTitle : "Changes not ready"}
        description="Walk through what changed, one change at a time."
        breadcrumb={headerCrumb}
      >
        <div className="mx-auto w-full max-w-[700px] rounded-dusk-card bg-dusk-surface px-6 py-8 text-center text-sm text-dusk-muted">
          <p>
            {waiting
              ? "This session hasn't gone quiet yet — changes appear here once the tape goes silent. Check back soon."
              : notFound
                ? "Changes not ready yet — the session may still be recording."
                : offline
                  ? "Couldn't reach the local Echo server — it may be restarting after a file change. Wait a moment, then retry."
                  : (errorMessage ?? "Could not load the changes.")}
          </p>
          {waiting || notFound || offline ? (
            <button
              type="button"
              onClick={() => {
                void changesQuery.refetch();
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

  return (
    <ScaffoldPage
      eyebrow="Session review"
      title={headerTitle}
      description="Walk through what changed, one change at a time."
      breadcrumb={{
        ...headerCrumb,
        // Current change totals ride the sticky header so scope stays
        // visible past the rail; the rail owns the per-area breakdown.
        side:
          code == null ? null : (
            <span className="font-mono text-xs tabular-nums">
              <span className="text-dusk-pass">
                +{code.files.reduce((sum, file) => sum + file.added, 0)}
              </span>{" "}
              <span className="text-dusk-fail">
                −{code.files.reduce((sum, file) => sum + file.removed, 0)}
              </span>
            </span>
          ),
      }}
    >
      <div className={`mx-auto w-full space-y-6 ${current !== null ? "" : "max-w-[700px]"}`}>
        {isEmpty ? (
          <div className="space-y-4 rounded-dusk-card bg-dusk-surface px-6 py-8 text-center">
            <p className="text-xs uppercase tracking-widest text-dusk-muted">No changes</p>
            <p className="text-dusk-body text-dusk-ink">
              {stillRecording
                ? "This session is still recording, but the agent hasn't changed any code yet. Chapters appear here once there's a diff to group."
                : "This session contains no code changes, so there's nothing to review."}
            </p>
          </div>
        ) : (
          <>
            <ProgressTape
              changes={changes}
              currentIndex={viewIndex}
              getState={(change) => progress[progressKey(change)]?.state}
              isLive={isLive}
              onJump={jump}
              onPeek={(index) => {
                const peeked = changes[index];
                if (peeked !== undefined) prefetchCode(queryClient, sessionId, peeked.id);
              }}
            />

            {current !== null ? (
              <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="min-w-0 space-y-6">
                  {/* The recap is the previous title only: digests are */}
                  {/* written for the model, not for people. */}
                  {previous !== null ? (
                    <p className="text-sm leading-6 text-dusk-muted">
                      Previously: {previous.title}
                    </p>
                  ) : null}

                  <ChangeCard
                    change={current}
                    code={code}
                    codeFailed={codeQuery.isError}
                    connections={changeConnections}
                    onJumpToChange={handleJumpToChange}
                  />

                  {checkError !== null && !atEnd ? (
                    <p role="alert" className="text-sm text-dusk-fail">
                      {checkError}
                    </p>
                  ) : null}

                  {checkOpen && checksState !== null && !atEnd ? (
                    <CheckRunner
                      sessionId={sessionId}
                      state={checksState}
                      focusQuestionId={checkFocusId}
                      onUpdate={setChecksState}
                      onSkip={() => void handleSkipCheck()}
                      onDone={handleRunnerDone}
                    />
                  ) : null}

                  {/* The action bar is fixed to the viewport, so this holds its in-flow room. */}
                  <div aria-hidden className="h-32 lg:h-20" />
                  <div className="fixed inset-x-0 bottom-0 z-20 border-t border-dusk-hairline bg-dusk-base lg:left-[max(1.5rem,calc((100vw-80rem)/2+1.5rem))] lg:right-[max(26rem,calc((100vw-80rem)/2+26rem))]">
                    <div
                      aria-hidden
                      className="pointer-events-none absolute -top-12 right-0 left-0 h-12 bg-gradient-to-b from-dusk-base/0 to-dusk-base"
                    />
                    <div className="px-6 pb-4 pt-4 lg:px-0">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => jump(viewIndex - 1)}
                          disabled={viewIndex === 0}
                          className={GHOST}
                        >
                          ← Back
                        </button>
                        <button
                          type="button"
                          onClick={handleGotIt}
                          disabled={gate !== null}
                          className={PRIMARY}
                        >
                          Got it, next change →
                        </button>
                      </div>
                    </div>
                  </div>

                  {viewIndex === changes.length - 1 && isLive ? (
                    <p className="text-sm text-dusk-muted">
                      The session is still going — this slot fills in when the next change lands.
                    </p>
                  ) : null}
                </div>

                <ReaderRail
                  changes={changes}
                  currentIndex={viewIndex}
                  getState={(change) => progress[progressKey(change)]?.state}
                  onJump={jump}
                  files={current.files}
                  codeFiles={code?.files ?? null}
                  tab={railTab}
                  onTabChange={setRailTab}
                  sessionId={sessionId}
                />
              </div>
            ) : isLive && !showSummary ? (
              <div className="space-y-4 rounded-dusk-card bg-dusk-surface px-6 py-8 text-center">
                <p className="text-xs uppercase tracking-widest text-dusk-muted">In progress</p>
                <p className="text-dusk-body text-dusk-ink">
                  The session is still going. New changes will appear here when it goes quiet.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <button type="button" onClick={() => jump(changes.length - 1)} className={QUIET}>
                    Back
                  </button>
                  <button type="button" onClick={() => setShowSummary(true)} className={QUIET}>
                    Caught up so far — show summary
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <CaughtUp
                  summary={summary}
                  skipped={skipped}
                  onDone={handleDone}
                  onRevisit={(change) => {
                    const index = changes.findIndex((candidate) => candidate.id === change.id);
                    if (index !== -1) jump(index);
                  }}
                />

                <div className="space-y-3 rounded-dusk-card bg-dusk-surface px-6 py-5">
                  <p className="text-xs uppercase tracking-widest text-dusk-muted">
                    Check your understanding
                  </p>
                  <p className="text-sm text-dusk-muted">
                    Up to three questions across this session&apos;s changes.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void handleStartCheck()}
                      disabled={checkBusy}
                      className={PRIMARY}
                    >
                      {checkBusy ? "Starting…" : "Check my understanding"}
                    </button>
                  </div>
                  {checkError !== null ? (
                    <p role="alert" className="text-sm text-dusk-fail">
                      {checkError}
                    </p>
                  ) : null}
                  {checkOpen && checksState !== null ? (
                    <CheckRunner
                      sessionId={sessionId}
                      state={checksState}
                      focusQuestionId={checkFocusId}
                      onUpdate={setChecksState}
                      onSkip={() => void handleSkipCheck()}
                      onDone={handleRunnerDone}
                    />
                  ) : null}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {gate !== null ? (
        <CheckGateModal
          changeTitle={gate.title}
          loading={gateLoading}
          error={checkError}
          hasQuestions={gateQuestions.length > 0}
          gateDone={gateDone}
          onSkip={resolveGate}
          onContinue={resolveGate}
        >
          {gateLoading ? null : gateQuestions.length === 0 && checkError === null ? (
            <p className="text-sm text-dusk-muted">
              Nothing to check on this change — continue when ready.
            </p>
          ) : checksState !== null ? (
            <CheckRunner
              sessionId={sessionId}
              state={checksState}
              focusQuestionId={checkFocusId}
              onUpdate={setChecksState}
              onDone={resolveGate}
              bare
            />
          ) : null}
        </CheckGateModal>
      ) : null}
    </ScaffoldPage>
  );
}
