import type { VerificationBadge, VerifiedCounts } from "@echo/contracts";
import { VERIFICATION_BADGE } from "./story-card";

const SEGMENTS: { badge: VerificationBadge; barClass: string }[] = [
  { badge: "observed", barClass: "bg-dusk-pass" },
  { badge: "partly_observed", barClass: "bg-dusk-accent" },
  { badge: "agent_stated", barClass: "bg-dusk-peach" },
  { badge: "nothing", barClass: "bg-dusk-faint" },
];

function countFor(counts: VerifiedCounts, badge: VerificationBadge): number {
  switch (badge) {
    case "observed":
      return counts.observed;
    case "partly_observed":
      return counts.partlyObserved;
    case "agent_stated":
      return counts.agentStated;
    case "nothing":
      return counts.nothing;
  }
}

export function VerifiedStackedBar({ counts }: { counts: VerifiedCounts }) {
  if (counts.total <= 0) {
    return <p className="text-sm text-dusk-muted">No cards to verify.</p>;
  }
  return (
    <div
      role="progressbar"
      aria-label="Verification coverage"
      aria-valuemin={0}
      aria-valuemax={counts.total}
      aria-valuenow={counts.observed}
      aria-valuetext={`${counts.observed} of ${counts.total} observed`}
      className="flex h-2.5 w-full overflow-hidden rounded-full bg-dusk-track"
    >
      {SEGMENTS.map(({ badge, barClass }) => {
        const value = countFor(counts, badge);
        return (
          <div
            key={badge}
            title={`${VERIFICATION_BADGE[badge].label}: ${value}`}
            style={{ width: `${(value / counts.total) * 100}%` }}
            className={`${barClass} transition-[width] duration-500 ease-out`}
          />
        );
      })}
    </div>
  );
}

type VerificationPanelProps = {
  counts: VerifiedCounts;
  hasLooseEnds: boolean;
  onStartCheck: () => void;
  starting: boolean;
  compact?: boolean;
};

export function VerificationPanel({
  counts,
  hasLooseEnds,
  onStartCheck,
  starting,
  compact = false,
}: VerificationPanelProps) {
  const total = counts.total;
  const plain =
    total <= 0
      ? "Nothing shipped to verify."
      : counts.observed === total
        ? `All ${total} ${total === 1 ? "change" : "changes"} fully observed.`
        : counts.observed > 0
          ? `${counts.observed} of ${total} changes fully observed, ${total - counts.observed} need a look.`
          : total === counts.partlyObserved && counts.partlyObserved > 0
            ? `All ${total} changes partly observed — no passing run on the tape.`
            : `${total - counts.observed} of ${total} changes still need verification.`;
  return (
    <div
      className={compact ? "space-y-2" : "space-y-4 rounded-dusk-card bg-dusk-surface px-6 py-5"}
    >
      <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
        How much is verified
      </p>
      <p className="text-sm text-dusk-ink">{plain}</p>
      <VerifiedStackedBar counts={counts} />
      <details className="text-xs text-dusk-muted">
        <summary className="cursor-pointer underline underline-offset-4">
          What do these levels mean?
        </summary>
        <div className="mt-2 flex flex-wrap gap-2">
          {SEGMENTS.map(({ badge }) => {
            const style = VERIFICATION_BADGE[badge];
            return (
              <span key={badge} title={style.title} className="flex items-baseline gap-2">
                <span className="text-sm font-semibold text-dusk-ink">
                  {countFor(counts, badge)}
                </span>
                <span
                  className={`rounded-dusk-code px-2 py-0.5 text-xs font-semibold ${style.className}`}
                >
                  {style.label}
                </span>
              </span>
            );
          })}
        </div>
      </details>
      <nav aria-label="Story sections" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <a
          href="#what-changed"
          className="text-dusk-muted underline underline-offset-4 hover:text-dusk-ink"
        >
          What changed
        </a>
        {hasLooseEnds ? (
          <a
            href="#loose-ends"
            className="text-dusk-muted underline underline-offset-4 hover:text-dusk-ink"
          >
            Loose ends
          </a>
        ) : null}
      </nav>
      {counts.total > 0 ? (
        <button
          type="button"
          onClick={onStartCheck}
          disabled={starting}
          className="w-full rounded-dusk-code bg-dusk-accent px-3 py-2 text-sm font-semibold text-dusk-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent disabled:opacity-40"
        >
          {starting ? "Starting…" : "Start check"}
        </button>
      ) : null}
    </div>
  );
}
