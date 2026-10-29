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
 * Session card for the project overview: the folder-preview item's shape
 * (title, time · events meta, triage badges) restyled onto the dusk surface
 * so it sits with the sidebar cards instead of the folder's paper sheet.
 */
export function SessionCard({ session }: { session: SessionSummary }) {
  const when = shortTime(session.startedAt);
  const exactTime = session.startedAt ? formatTime(session.startedAt) : null;
  const meta = `${when ?? "unknown time"} · ${session.eventCount} event${session.eventCount === 1 ? "" : "s"}`;

  return (
    <Link
      to={`/sessions/${session.id}`}
      title={exactTime ?? undefined}
      className="flex h-full flex-col rounded-[20px] border border-dusk-hairline bg-dusk-surface p-5 transition-colors hover:border-dusk-accent/40 hover:bg-dusk-pill/30 focus-visible:outline-2 focus-visible:outline-dusk-accent"
    >
      <span className="line-clamp-2 text-[15px] font-medium leading-snug tracking-tight text-dusk-ink">
        {cardTitle(session)}
      </span>
      <span className="mt-1.5 font-mono text-xs text-dusk-muted">{meta}</span>
      <span className="mt-auto flex flex-wrap items-center gap-2 pt-4 text-xs">
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
