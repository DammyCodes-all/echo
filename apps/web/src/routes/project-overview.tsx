import type { SessionSummary } from "@echo/contracts";
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
    <div className="space-y-8">
      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
          <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">Purpose</p>
          <p className="mt-2 text-sm leading-6 text-dusk-ink">
            Echo reviews what this repo&apos;s coding agents did — one short story per session, then
            a check that calibration matches reality.
          </p>
          <p className="mt-3 font-mono text-xs text-dusk-muted">
            {project.data?.root ?? "…"}
            {project.data?.remoteUrl ? ` · ${project.data.remoteUrl}` : ""}
          </p>
        </div>
        <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
          <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
            Current state
          </p>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <span>
              <span className="text-xl font-semibold">{list.length}</span>{" "}
              <span className="text-dusk-muted">sessions</span>
            </span>
            <span>
              <span className="text-xl font-semibold">{checked}</span>{" "}
              <span className="text-dusk-muted">checked</span>
            </span>
            <span>
              <span className="text-xl font-semibold">{skipped}</span>{" "}
              <span className="text-dusk-muted">skipped</span>
            </span>
            <span>
              <span className="text-xl font-semibold">{highRisk}</span>{" "}
              <span className="text-dusk-muted">high-risk cards</span>
            </span>
          </div>
          <p className="mt-3 text-sm text-dusk-muted">
            Main features under review: story cards · Ask why with refusal · calibration checks.
          </p>
          <p className="mt-1 font-mono text-xs text-dusk-muted">
            Stack: {stackFromRemote(project.data?.remoteUrl ?? null)} · TypeScript-first capture ·
            local daemon + SQLite
          </p>
        </div>
      </section>

      <section className="space-y-3">
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
