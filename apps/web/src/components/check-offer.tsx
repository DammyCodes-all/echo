type CheckOfferProps = {
  hasHighRisk: boolean;
  questionCount: number | null;
  onStart: () => void;
  onSkip: () => void;
  starting: boolean;
};

export function CheckOffer({
  hasHighRisk,
  questionCount,
  onStart,
  onSkip,
  starting,
}: CheckOfferProps) {
  if (!hasHighRisk) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-dusk-card bg-dusk-surface px-6 py-4">
        <p className="text-sm text-dusk-muted">Quick check available.</p>
        <button
          type="button"
          onClick={onStart}
          disabled={starting}
          className="rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink disabled:opacity-40"
        >
          {starting ? "Starting…" : "Start check"}
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
        <button
          type="button"
          onClick={onStart}
          disabled={starting}
          className="rounded-dusk-code bg-dusk-accent px-3 py-2 text-sm font-semibold text-dusk-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent disabled:opacity-40"
        >
          {starting ? "Starting…" : "Start check"}
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
