import { useEffect, useState } from "react";

type CheckOfferProps = {
  hasHighRisk: boolean;
  questionCount: number | null;
  onStart: () => void;
  onSkip: () => void;
  onCancel: () => void;
  starting: boolean;
};

const PRIMARY =
  "rounded-dusk-pill bg-dusk-accent px-5 py-2.5 text-sm font-semibold text-dusk-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent disabled:opacity-40";
const SECONDARY =
  "rounded-dusk-pill bg-dusk-secondary px-5 py-2.5 text-sm font-semibold text-dusk-accent-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent disabled:opacity-40";

function useElapsedSeconds(running: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return elapsed;
}

export function CheckOffer({
  hasHighRisk,
  questionCount,
  onStart,
  onSkip,
  onCancel,
  starting,
}: CheckOfferProps) {
  const elapsed = useElapsedSeconds(starting);

  if (starting) {
    return (
      <div className="flex flex-wrap items-center gap-4 rounded-dusk-card bg-dusk-surface px-6 py-5">
        <p className="text-sm text-dusk-muted tabular-nums" aria-live="polite">
          Starting… {elapsed}s — writing questions from the session.
        </p>
        <button type="button" onClick={onCancel} className={SECONDARY}>
          Cancel
        </button>
      </div>
    );
  }

  if (!hasHighRisk) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-dusk-card bg-dusk-surface px-6 py-4">
        <p className="text-sm text-dusk-muted">Quick check available.</p>
        <button type="button" onClick={onStart} disabled={starting} className={PRIMARY}>
          Start check
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={starting}
          className="text-sm text-dusk-muted underline underline-offset-4 disabled:opacity-40"
        >
          Skip — no pressure
        </button>
      </div>
    );
  }

  const title =
    questionCount !== null && questionCount > 0
      ? `Test your understanding — ${questionCount} question${questionCount === 1 ? "" : "s"}`
      : "Test your understanding";
  return (
    <div className="space-y-3 rounded-dusk-card bg-dusk-surface px-6 py-5">
      <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
        Understanding check
      </p>
      <p className="text-dusk-body text-dusk-ink">{title}</p>
      <p className="text-sm text-dusk-muted">Private calibration, never a grade, skip anytime.</p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onStart} disabled={starting} className={PRIMARY}>
          Start check
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={starting}
          className="text-sm text-dusk-muted underline underline-offset-4 disabled:opacity-40"
        >
          Skip — no pressure
        </button>
      </div>
    </div>
  );
}
