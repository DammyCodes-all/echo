export interface GraphCardProps {
  label: string;
  description?: string;
  status: "existing" | "proposed";
  hubUsers?: number | null;
}

/**
 * Graph node body in the jul.chat dark-card language: centered title with a
 * single muted description line. The React Flow frame (size, border, tint,
 * handles) stays in `architecture-diagram.tsx`; this is content only so the
 * 160x48 ELK box never overflows.
 */
export function GraphCard({ label, description, status, hubUsers = null }: GraphCardProps) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center overflow-hidden px-3 py-1.5 text-center">
      <h2 className="w-full truncate text-[13px] font-semibold leading-5 text-dusk-ink">{label}</h2>
      {description ? (
        <p className="mt-px w-full truncate text-[11px] leading-4 text-dusk-muted">{description}</p>
      ) : null}
      {status === "proposed" ? (
        <span className="mt-1 inline-block rounded-dusk-pill bg-dusk-peach-wash px-2 py-px text-[10px] uppercase tracking-widest text-dusk-peach">
          proposed
        </span>
      ) : null}
      {hubUsers !== null && hubUsers !== undefined ? (
        <span className="absolute -right-2 -top-2 rounded-dusk-pill bg-dusk-pill px-1.5 py-px font-mono text-[10px] text-dusk-muted shadow">
          used by {hubUsers}
        </span>
      ) : null}
    </div>
  );
}
