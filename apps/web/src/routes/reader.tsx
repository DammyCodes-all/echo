import type {
  AskEvidence,
  Change,
  ChangeId,
  ChecksV2Response,
  ProgressState,
} from "@echo/contracts";
import { firstNotUnderstood } from "@echo/contracts";
import { GitCompareArrowsIcon } from "@hugeicons/core-free-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api, ChangesNotReadyError } from "../api";
import { summarizeChangeChecks } from "../checks-summary";
import { type AskChangeRef, AskThreadPanel } from "../components/ask-thread-panel";
import { CaughtUp } from "../components/caught-up";
import { ChangeCard } from "../components/change-card";
import { CheckRunner } from "../components/check-runner";
import { ProgressTape } from "../components/progress-tape";
import { ReaderRail } from "../components/reader-rail";
import { ScaffoldPage } from "../components/scaffold-page";

const PRIMARY =
  "rounded-dusk-pill bg-dusk-accent px-5 py-2.5 text-sm font-semibold text-dusk-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent disabled:opacity-40";
const QUIET = "text-sm text-dusk-muted underline underline-offset-4 disabled:opacity-40";

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
    queryKey: ["changes", sessionId],
    queryFn: () => api.changes(sessionId),
  });

  // Header owns project/session names; changes own the body. Separate
  // queries so a slow session row never blocks the change list.
  const sessionQuery = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => api.session(sessionId),
    retry: false,
  });
  const projectId = sessionQuery.data?.projectId ?? "";
  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.project(projectId),
    enabled: projectId.length > 0,
    retry: false,
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

  // Ask panel anchor: the change the question is about (panel side ready).
  const [askChange, setAskChange] = useState<AskChangeRef>(null);
  const [askOpen, setAskOpen] = useState(false);

  // Checks v2 runner state, shared by the per-change and caught-up offers.
  const [checksState, setChecksState] = useState<ChecksV2Response | null>(null);
  const [checkFocusId, setCheckFocusId] = useState<string | null>(null);
  const [checkOpen, setCheckOpen] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

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
        void queryClient.invalidateQueries({ queryKey: ["changes", sessionId] });
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
  const codeQuery = useQuery({
    queryKey: ["code", sessionId, current?.id],
    queryFn: () => api.changeCode(sessionId, current?.id ?? ""),
    enabled: current !== null,
    retry: false,
  });
  const code = codeQuery.data?.changeId === current?.id ? codeQuery.data : null;

  // Stored check state for the inline per-change result line. The runner's
  // live state wins once a check runs this visit.
  const storedChecksQuery = useQuery({
    queryKey: ["checks", sessionId],
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
  // Other changes touching the same files, in session order. Pure overlap
  // from the served list — no backend needed.
  const currentPaths = new Set((current?.files ?? []).map((file) => file.path));
  const related = changes.flatMap((change, index) =>
    change.id === current?.id || !change.files.some((file) => currentPaths.has(file.path))
      ? []
      : [{ index, title: change.title }],
  );

  const handleDone = () => {
    navigate("/projects");
  };

  const handleAsk = (ref: { id: string; title: string }) => {
    setAskChange(ref);
    setAskOpen(true);
  };

  const handleCitationClick = (citation: AskEvidence, messageCardId?: string | null) => {
    // Change-anchored threads persist cardId null, so prefer the message's
    // card when it names a change, then the change touching the cited file,
    // then the panel anchor.
    const direct =
      messageCardId !== null &&
      messageCardId !== undefined &&
      changes.some((change) => change.id === messageCardId)
        ? messageCardId
        : null;
    const byFile =
      citation.filePath !== null && citation.filePath !== undefined
        ? (changes.find((change) => change.files.some((file) => file.path === citation.filePath))
            ?.id ?? null)
        : null;
    const targetId = direct ?? byFile ?? askChange?.id ?? null;
    if (targetId === null) return;
    requestAnimationFrame(() => {
      document
        .getElementById(`change-${targetId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const handleCheckMe = async (change: Change) => {
    if (checkBusy) return;
    setCheckBusy(true);
    setCheckError(null);
    try {
      const next = await api.checkMe(sessionId, change.id);
      setChecksState(next);
      setCheckFocusId(next.questions.find((question) => question.cardId === change.id)?.id ?? null);
      setCheckOpen(true);
    } catch (unknown) {
      setCheckError(checkMessage(unknown));
    } finally {
      setCheckBusy(false);
    }
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

  if (changesQuery.isPending) {
    return (
      <ScaffoldPage
        eyebrow="Session review"
        title={headerTitle}
        description="Walk through what changed, one change at a time."
        breadcrumb={headerCrumb}
      >
        <div
          role="status"
          aria-label="Loading changes"
          className="mx-auto w-full max-w-[700px] space-y-6"
        >
          <span className="sr-only">Loading changes…</span>
          <div aria-hidden>
            <div className="flex items-center gap-1.5 motion-safe:animate-pulse">
              {["a", "b", "c", "d", "e"].map((key) => (
                <div key={key} className="h-1.5 flex-1 rounded-full bg-dusk-track" />
              ))}
            </div>
            <div className="mt-2 h-4 w-24 rounded-dusk-code bg-dusk-pill motion-safe:animate-pulse" />
          </div>
          <div
            aria-hidden
            className="space-y-4 rounded-dusk-card bg-dusk-surface px-6 py-8 motion-safe:animate-pulse"
          >
            <div className="h-6 w-2/3 rounded-dusk-code bg-dusk-pill" />
            <div className="space-y-2">
              <div className="h-4 w-full rounded-dusk-code bg-dusk-pill" />
              <div className="h-4 w-5/6 rounded-dusk-code bg-dusk-pill" />
            </div>
            <div className="flex gap-3 border-t border-dusk-hairline pt-4">
              <div className="h-10 w-28 rounded-dusk-pill bg-dusk-pill" />
              <div className="h-10 w-36 rounded-dusk-pill bg-dusk-pill" />
            </div>
          </div>
        </div>
      </ScaffoldPage>
    );
  }

  if (changesQuery.isError || changesQuery.data === undefined) {
    const waiting = changesQuery.error instanceof ChangesNotReadyError;
    const notFound = isNotFound(changesQuery.error);
    return (
      <ScaffoldPage
        eyebrow="Session review"
        title={waiting || notFound ? headerTitle : "Changes not ready"}
        description="Walk through what changed, one change at a time."
        breadcrumb={headerCrumb}
      >
        <div className="mx-auto w-full max-w-[700px] rounded-dusk-card bg-dusk-surface px-6 py-8 text-center text-sm text-dusk-muted">
          <p>
            {waiting
              ? "This session hasn't gone quiet yet — changes appear here once the tape goes silent. Check back soon."
              : notFound
                ? "Changes not ready yet — the session may still be recording."
                : changesQuery.error instanceof Error
                  ? changesQuery.error.message
                  : "Could not load the changes."}
          </p>
          {waiting || notFound ? (
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
      breadcrumb={headerCrumb}
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
            />

            {current !== null ? (
              <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
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
                    onAsk={handleAsk}
                    onCheck={(change) => void handleCheckMe(change)}
                    checkBusy={checkBusy}
                    code={code}
                    codeFailed={codeQuery.isError}
                    checkResult={checkResult}
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

                  <div className="space-y-2 border-t border-dusk-hairline pt-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={() => jump(viewIndex - 1)}
                        disabled={viewIndex === 0}
                        className={QUIET}
                      >
                        Back
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          mark(current, "skipped");
                          jump(viewIndex + 1);
                        }}
                        className={QUIET}
                      >
                        Skip quietly
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          mark(current, "understood");
                          jump(viewIndex + 1);
                        }}
                        className={PRIMARY}
                      >
                        Got it, next change
                      </button>
                    </div>
                    <p className="text-sm text-dusk-muted">
                      {next !== null ? `Next up: ${next.title}` : "Last one — the wrap-up is next."}
                    </p>
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
                  related={related}
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
      {askOpen ? (
        <AskThreadPanel
          sessionId={sessionId}
          card={null}
          change={askChange}
          onClearCard={() => setAskChange(null)}
          onCitationClick={handleCitationClick}
          onClose={() => setAskOpen(false)}
        />
      ) : null}
    </ScaffoldPage>
  );
}
