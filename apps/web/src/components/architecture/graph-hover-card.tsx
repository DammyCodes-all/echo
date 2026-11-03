export interface GraphHoverCardProps {
  label: string;
  description?: string;
  sessions: number;
  totalSessions: number;
}

/**
 * Hover modal in the jul.chat dark-card language: centered title, muted
 * description, one quiet evidence line. Neighbor names stay out — hovering
 * already lights up the connected edges, so the graph shows it. Pinning
 * happens via node click; the card itself carries no actions.
 */
export function GraphHoverCard({
  label,
  description,
  sessions,
  totalSessions,
}: GraphHoverCardProps) {
  return (
    <div className="arch-popover-in w-64 space-y-1.5 overflow-hidden rounded-3xl border border-dusk-hairline-strong bg-dusk-surface px-4 py-4 text-center shadow-xl">
      <h2 className="text-sm font-semibold leading-6 text-dusk-ink">{label}</h2>
      {description ? <p className="text-[13px] leading-5 text-dusk-muted">{description}</p> : null}
      {sessions > 0 ? (
        <p className="text-xs leading-5 text-dusk-muted">
          Touched in{" "}
          <span className="font-semibold text-dusk-ink">
            {sessions} of {totalSessions}
          </span>{" "}
          sessions
        </p>
      ) : null}
    </div>
  );
}
