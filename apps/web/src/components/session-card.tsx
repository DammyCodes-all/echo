import type { SessionSummary } from "@echo/contracts";
import { Link } from "react-router";
import { formatTime } from "../api";

function timeAgo(iso: string | null): string {
  if (!iso) return "unknown time";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown time";
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
 * Session card for the project overview: title, relative time, and only the
 * badges that say something — high-risk flags plus the non-default check
 * states. The default `not_checked` and the capture/event-count details stay
 * off the card; the story page owns them.
 */
export function SessionCard({ session }: { session: SessionSummary }) {
  const exactTime = session.startedAt ? formatTime(session.startedAt) : null;

  return (
    <Link
      to={`/sessions/${session.id}`}
      title={exactTime ?? undefined}
      className="flex h-full flex-col rounded-[20px] border border-dusk-hairline bg-dusk-surface p-5 transition-colors hover:border-dusk-accent/40 hover:bg-dusk-pill/30 focus-visible:outline-2 focus-visible:outline-dusk-accent"
    >
      <span className="line-clamp-2 text-[15px] font-medium leading-snug tracking-tight text-dusk-ink">
        {cardTitle(session)}
      </span>
      <span className="mt-1.5 font-mono text-xs text-dusk-muted">{timeAgo(session.startedAt)}</span>
      {session.checkStatus !== "not_checked" || session.highRiskCount > 0 ? (
        <span className="mt-auto flex flex-wrap items-center gap-2 pt-4 text-xs">
          {session.checkStatus !== "not_checked" ? (
            <span className={checkBadgeClass(session.checkStatus)}>
              {checkLabel(session.checkStatus)}
            </span>
          ) : null}
          {session.highRiskCount > 0 ? (
            <span className="rounded-dusk-pill border border-dusk-fail/40 bg-dusk-fail-wash px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-dusk-fail">
              {session.highRiskCount} high-risk
            </span>
          ) : null}
        </span>
      ) : null}
    </Link>
  );
}
