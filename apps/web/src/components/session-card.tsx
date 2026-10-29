import type { SessionSummary } from "@echo/contracts";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  SkipForwardIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo } from "react";
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
    "inline-flex items-center gap-1 rounded-dusk-pill border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest";
  if (checkStatus === "checked")
    return `${base} border-dusk-pass/40 bg-dusk-pass-wash text-dusk-pass`;
  return `${base} border-dusk-hairline-strong text-dusk-muted`;
}

function checkLabel(checkStatus: SessionSummary["checkStatus"]): string {
  if (checkStatus === "checked") return "Checked";
  if (checkStatus === "skipped") return "Skipped";
  return "Not checked";
}

function checkIcon(checkStatus: SessionSummary["checkStatus"]) {
  return checkStatus === "checked" ? CheckmarkCircle02Icon : SkipForwardIcon;
}

/**
 * Session card for the project overview: title, then one bottom row with the
 * relative last-activity time and only the badges that say something —
 * high-risk flags plus the non-default check states. The default
 * `not_checked` and the capture/event-count details stay off the card; the
 * story page owns them.
 *
 * Memoized: the list re-renders every poll, and React Query keeps unchanged
 * rows referentially equal, so only new/changed sessions pay for a render.
 */
export const SessionCard = memo(function SessionCard({ session }: { session: SessionSummary }) {
  const showCheck = session.checkStatus !== "not_checked";
  const showRisk = session.highRiskCount > 0;

  return (
    <Link
      to={`/sessions/${session.id}`}
      className="flex h-full flex-col rounded-[20px] border border-dusk-hairline bg-dusk-surface p-5 transition-colors hover:border-dusk-accent/40 hover:bg-dusk-pill/30 focus-visible:outline-2 focus-visible:outline-dusk-accent"
    >
      <span className="line-clamp-2 min-h-[2.75em] text-[15px] font-medium leading-snug tracking-tight text-dusk-ink">
        {cardTitle(session)}
      </span>
      <span className="mt-auto flex items-center justify-between gap-3 pt-4">
        <span
          className="inline-flex items-center gap-1.5 font-mono text-xs text-dusk-muted"
          title={formatTime(session.lastActivity)}
        >
          <span aria-hidden className="inline-flex">
            <HugeiconsIcon icon={Clock01Icon} size={14} strokeWidth={1.8} />
          </span>
          {timeAgo(session.lastActivity)}
        </span>
        {showCheck || showRisk ? (
          <span className="flex shrink-0 items-center gap-2 text-xs">
            {showCheck ? (
              <span className={checkBadgeClass(session.checkStatus)}>
                <span aria-hidden className="inline-flex">
                  <HugeiconsIcon icon={checkIcon(session.checkStatus)} size={12} strokeWidth={2} />
                </span>
                {checkLabel(session.checkStatus)}
              </span>
            ) : null}
            {showRisk ? (
              <span className="inline-flex items-center gap-1 rounded-dusk-pill border border-dusk-fail/40 bg-dusk-fail-wash px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-dusk-fail">
                <span aria-hidden className="inline-flex">
                  <HugeiconsIcon icon={Alert02Icon} size={12} strokeWidth={2} />
                </span>
                {session.highRiskCount} high-risk
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </Link>
  );
});
