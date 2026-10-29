import type { SessionSummary } from "@echo/contracts";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Database01Icon,
  Folder01Icon,
  GitBranchIcon,
  Layers01Icon,
  SkipForwardIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api, formatTime } from "../api";

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

function rowSummary(session: SessionSummary): string {
  if (session.summary) return session.summary;
  if (session.captureState === "recording") return "Still recording — story pending…";
  return "No summary";
}

function stackFromRemote(remoteUrl: string | null): string {
  if (!remoteUrl) return "Local-only checkout";
  if (remoteUrl.includes("github.com")) return "Git · GitHub";
  if (remoteUrl.includes("gitlab")) return "Git · GitLab";
  return "Git";
}

export function ProjectOverviewPage() {
  const { projectId = "" } = useParams();
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.project(projectId),
  });
  const sessions = useQuery({
    queryKey: ["sessions", projectId],
    queryFn: () => api.sessions(projectId),
    refetchInterval: 5000,
  });

  const list = sessions.data ?? [];
  const checked = list.filter((s) => s.checkStatus === "checked").length;
  const skipped = list.filter((s) => s.checkStatus === "skipped").length;
  const highRisk = list.reduce((sum, s) => sum + s.highRiskCount, 0);

  return (
    <div className="lg:grid lg:grid-cols-[300px_minmax(0,1fr)] lg:items-start lg:gap-6">
      <aside className="sticky top-[72px] max-h-[calc(100vh-96px)] space-y-4 overflow-y-auto overscroll-contain">
        <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
          <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">Purpose</p>
          <p className="mt-2 text-sm leading-6 text-dusk-ink">
            Echo reviews what this repo&apos;s coding agents did — one short story per session, then
            a check that calibration matches reality.
          </p>
          <p className="mt-3 flex items-center gap-1.5 break-all font-mono text-xs text-dusk-muted">
            <span aria-hidden className="inline-flex shrink-0">
              <HugeiconsIcon icon={Folder01Icon} size={14} strokeWidth={1.8} />
            </span>
            <span>
              {project.data?.root ?? "…"}
              {project.data?.remoteUrl ? ` · ${project.data.remoteUrl}` : ""}
            </span>
          </p>
        </div>
        <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
          <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
            Current state
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-5 text-sm">
            <div>
              <div className="flex items-center gap-1.5">
                <span aria-hidden className="inline-flex text-dusk-accent">
                  <HugeiconsIcon icon={Layers01Icon} size={20} strokeWidth={1.8} />
                </span>
                <dd className="text-2xl font-semibold tracking-tight tabular-nums">
                  {list.length}
                </dd>
              </div>
              <dt className="mt-1 text-xs text-dusk-muted">Sessions</dt>
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span aria-hidden className="inline-flex text-dusk-pass">
                  <HugeiconsIcon icon={CheckmarkCircle02Icon} size={20} strokeWidth={1.8} />
                </span>
                <dd className="text-2xl font-semibold tracking-tight tabular-nums">{checked}</dd>
              </div>
              <dt className="mt-1 text-xs text-dusk-muted">Checked</dt>
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span aria-hidden className="inline-flex text-dusk-peach">
                  <HugeiconsIcon icon={SkipForwardIcon} size={20} strokeWidth={1.8} />
                </span>
                <dd className="text-2xl font-semibold tracking-tight tabular-nums">{skipped}</dd>
              </div>
              <dt className="mt-1 text-xs text-dusk-muted">Skipped</dt>
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={`inline-flex ${highRisk > 0 ? "text-dusk-fail" : "text-dusk-muted"}`}
                >
                  <HugeiconsIcon icon={Alert02Icon} size={20} strokeWidth={1.8} />
                </span>
                <dd
                  className={`text-2xl font-semibold tracking-tight tabular-nums ${highRisk > 0 ? "text-dusk-fail" : ""}`}
                >
                  {highRisk}
                </dd>
              </div>
              <dt className="mt-1 text-xs text-dusk-muted">High-risk cards</dt>
            </div>
          </dl>
          <div className="mt-4 border-t border-dusk-hairline pt-4">
            <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
              Tech stack
            </p>
            <dl className="mt-3 space-y-2 text-xs">
              <div className="flex items-center gap-2">
                <span aria-hidden className="inline-flex text-dusk-muted">
                  <HugeiconsIcon icon={GitBranchIcon} size={14} strokeWidth={1.8} />
                </span>
                <dt className="text-dusk-muted">Checkout</dt>
                <dd className="ml-auto text-right text-dusk-ink">
                  {stackFromRemote(project.data?.remoteUrl ?? null)}
                </dd>
              </div>
              <div className="flex items-center gap-2">
                <span aria-hidden className="inline-flex text-dusk-muted">
                  <HugeiconsIcon icon={TerminalIcon} size={14} strokeWidth={1.8} />
                </span>
                <dt className="text-dusk-muted">Capture</dt>
                <dd className="ml-auto text-right text-dusk-ink">TypeScript-first</dd>
              </div>
              <div className="flex items-center gap-2">
                <span aria-hidden className="inline-flex text-dusk-muted">
                  <HugeiconsIcon icon={Database01Icon} size={14} strokeWidth={1.8} />
                </span>
                <dt className="text-dusk-muted">Runtime</dt>
                <dd className="ml-auto text-right text-dusk-ink">local daemon + SQLite</dd>
              </div>
            </dl>
          </div>
        </div>
      </aside>

      <section className="mt-8 space-y-3 lg:mt-0">
        <h2 className="text-xl font-semibold tracking-tight">Agent sessions</h2>
        {sessions.isError ? (
          <div className="rounded-dusk-card border border-dusk-fail/40 bg-dusk-fail-wash p-8 text-sm text-dusk-fail">
            Could not load sessions.
          </div>
        ) : null}
        {sessions.data && sessions.data.length === 0 ? (
          <div className="rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
            No sessions captured for this project yet.
          </div>
        ) : null}
        {list.length > 0 ? (
          <div className="divide-y divide-dusk-hairline overflow-hidden rounded-dusk-card bg-dusk-surface">
            {list.map((session) => (
              <Link
                key={session.id}
                to={`/sessions/${session.id}`}
                className="flex flex-col gap-2 px-6 py-5 transition-colors hover:bg-dusk-pill/60 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-dusk-ink">{rowSummary(session)}</p>
                  <p className="mt-1 font-mono text-xs text-dusk-muted">
                    {session.startedAt ? formatTime(session.startedAt) : "unknown time"} ·{" "}
                    {session.eventCount} events
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
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
                </div>
              </Link>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
