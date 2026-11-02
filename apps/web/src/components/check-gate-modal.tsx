import { useEffect } from "react";

const QUIET = "text-sm text-dusk-muted underline underline-offset-4 disabled:opacity-40";
const PRIMARY =
  "rounded-dusk-pill bg-dusk-accent px-5 py-2.5 text-sm font-semibold text-dusk-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent disabled:opacity-40";

type CheckGateModalProps = {
  changeTitle: string;
  loading: boolean;
  error: string | null;
  hasQuestions: boolean;
  gateDone: boolean;
  onSkip: () => void;
  onContinue: () => void;
  children: React.ReactNode;
};

/**
 * Blocking transition gate: one quick check before the next change.
 * Skip is always available so a failed or unwanted check never traps
 * the reader; Continue unlocks once this change's questions are
 * answered (or when there is nothing to answer). The runner renders
 * bare inside: this modal owns the card, the label, and the footer.
 */
export function CheckGateModal({
  changeTitle,
  loading,
  error,
  hasQuestions,
  gateDone,
  onSkip,
  onContinue,
  children,
}: CheckGateModalProps) {
  const canContinue = !loading && (error !== null || !hasQuestions || gateDone);

  // Escape skips the check, never the change: same as the Skip button.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onSkip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSkip]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div aria-hidden className="absolute inset-0 bg-black/60" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Understanding check before leaving ${changeTitle}`}
        className="gate-modal-in relative max-h-[85vh] w-full max-w-[560px] space-y-4 overflow-y-auto rounded-dusk-card bg-dusk-surface px-6 py-5"
      >
        <div>
          <p className="text-xs uppercase tracking-widest text-dusk-muted">Understanding check</p>
          <p className="mt-1 truncate text-sm text-dusk-muted" title={changeTitle}>
            On this change: {changeTitle}
          </p>
        </div>

        {loading ? (
          <div role="status" className="space-y-4">
            <div aria-hidden className="space-y-2 motion-safe:animate-pulse">
              <div className="h-4 w-11/12 rounded-dusk-code bg-dusk-pill" />
              <div className="h-4 w-2/3 rounded-dusk-code bg-dusk-pill" />
            </div>
            <div aria-hidden className="space-y-2 motion-safe:animate-pulse">
              <div className="h-3 w-40 rounded-dusk-code bg-dusk-pill" />
              <div className="flex gap-2">
                <div className="h-9 w-24 rounded-dusk-code bg-dusk-pill" />
                <div className="h-9 w-24 rounded-dusk-code bg-dusk-pill" />
                <div className="h-9 w-20 rounded-dusk-code bg-dusk-pill" />
              </div>
            </div>
            <p className="text-sm text-dusk-muted">Writing your check…</p>
          </div>
        ) : (
          children
        )}

        {error !== null && !loading ? (
          <p role="alert" className="text-sm text-dusk-fail">
            {error} You can continue anyway.
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-dusk-hairline pt-4">
          <button type="button" onClick={onSkip} className={QUIET}>
            Skip check
          </button>
          {canContinue || loading ? (
            <button type="button" onClick={onContinue} disabled={!canContinue} className={PRIMARY}>
              {loading
                ? "Preparing check…"
                : hasQuestions && !gateDone && error === null
                  ? "Answer to continue"
                  : "Continue to next change"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
