import type { SessionSummary } from "@echo/contracts";
import { Link } from "react-router";
import { formatTime } from "../api";

function shortTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time}`;
}

function cardTitle(session: SessionSummary): string {
  if (session.summary) return session.summary;
  if (session.captureState === "recording") return "Still recording — story pending…";
  return "No summary";
}

function checkBadgeClass(checkStatus: SessionSummary["checkStatus"]): string {
  const base =
    "rounded-dusk-pill border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest";
  if (checkStatus === "checked")
    return `${base} border-dusk-pass/40 bg-dusk-pass-wash text-dusk-pass`;
  return `${base} border-dusk-hairline-strong text-dusk-muted`;
}

function checkLabel(checkStatus: SessionSummary["checkStatus"]): string {
  if (checkStatus === "checked") return "Checked";
  if (checkStatus === "skipped") return "Skipped";
  return "Not checked";
}

/**
 * Standalone version of the folder file sheet on `/` (same title/meta/detail
 * shape as the preview inside `ProjectFolderCard`), with the triage badges
 * the overview list used to carry.
 */
export function SessionCard({ session }: { session: SessionSummary }) {
  const when = shortTime(session.startedAt);
  const detail = session.model && when ? `${when} · ${session.model}` : (when ?? session.model);
  const exactTime = session.startedAt ? formatTime(session.startedAt) : null;

  return (
    <Link
      to={`/sessions/${session.id}`}
      className="flex h-full flex-col rounded-[16px] border border-white/[0.08] bg-gradient-to-b from-[#2c2c30] to-[#1c1c1f] p-[14px] shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_12px_28px_-8px_rgba(0,0,0,0.7)] transition-colors hover:border-dusk-accent/40 focus-visible:outline-2 focus-visible:outline-dusk-accent"
    >
      <span className="flex items-baseline justify-between gap-2.5">
        <span className="line-clamp-2 min-h-[2.6em] text-sm font-medium leading-[1.3] tracking-[-0.005em] text-[#fafafa]">
          {cardTitle(session)}
        </span>
        <span className="flex-none font-mono text-[10px] tracking-[0.02em] text-white/60">
          {session.eventCount} event{session.eventCount === 1 ? "" : "s"}
        </span>
      </span>
      {detail ? (
        <span
          className="mt-2 truncate text-xs leading-[1.35] tracking-[0.01em] text-white/60"
          title={exactTime ?? undefined}
        >
          {detail}
        </span>
      ) : null}
      <span className="mt-auto flex flex-wrap items-center gap-2 pt-3 text-xs">
        <span className={checkBadgeClass(session.checkStatus)}>
          {checkLabel(session.checkStatus)}
        </span>
        {session.highRiskCount > 0 ? (
          <span className="rounded-dusk-pill border border-dusk-fail/40 bg-dusk-fail-wash px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-dusk-fail">
            {session.highRiskCount} high-risk
          </span>
        ) : null}
        {session.captureState !== "ready" ? (
          <span className="rounded-dusk-pill border border-dusk-hairline-strong px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-dusk-peach">
            {session.captureState}
          </span>
        ) : null}
      </span>
    </Link>
  );
}
