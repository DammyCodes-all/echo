export interface GraphHoverCardProps {
  label: string;
  description?: string;
  receivesFrom: string[];
  sendsTo: string[];
  sessions: number;
  totalSessions: number;
  lastTouchedLabel: string;
}

function HoverNeighborList({ title, names }: { title: string; names: string[] }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-dusk-muted">{title}</p>
      <p className="mt-0.5 text-[13px] leading-5 text-dusk-ink">
        {names.length > 0 ? names.join(", ") : "—"}
      </p>
    </div>
  );
}

/**
 * Hover modal in the jul.chat dark-card language: centered title, muted
 * description, neighbor lists, and evidence lines. Pinning happens via
 * node click; the card itself carries no actions.
 */
export function GraphHoverCard({
  label,
  description,
  receivesFrom,
  sendsTo,
  sessions,
  totalSessions,
  lastTouchedLabel,
}: GraphHoverCardProps) {
  return (
    <div className="arch-popover-in w-64 space-y-2 overflow-hidden rounded-3xl border border-dusk-hairline-strong bg-dusk-surface p-3 pt-5 text-center shadow-xl">
      <h2 className="text-sm font-medium text-dusk-ink">{label}</h2>
      {description ? <p className="text-[13px] leading-5 text-dusk-muted">{description}</p> : null}
      <div className="space-y-2 text-center">
        <HoverNeighborList title="Receives from" names={receivesFrom} />
        <HoverNeighborList title="Sends to" names={sendsTo} />
        <p className="text-[13px] text-dusk-ink">
          Agent worked here:{" "}
          <span className="font-semibold">
            {sessions} of {totalSessions} sessions
          </span>
        </p>
        <p className="font-mono text-[11px] text-dusk-muted">Last touched: {lastTouchedLabel}</p>
      </div>
    </div>
  );
}
