import type { SessionSummary } from "@echo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { api, formatTime } from "../api";
import { ScaffoldPage } from "../components/scaffold-page";

const LAST_PROJECT_KEY = "echo:lastProject";

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

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const sessions = useQuery({
    queryKey: ["sessions", projectId],
    queryFn: () => api.sessions(projectId),
    refetchInterval: 5000,
  });
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: api.projects,
  });

  useEffect(() => {
    if (sessions.isSuccess) {
      try {
        localStorage.setItem(LAST_PROJECT_KEY, projectId);
      } catch {
        // Private-mode storage failure must not break the inbox.
      }
    }
  }, [sessions.isSuccess, projectId]);

  const projectName = projects.data?.find((project) => project.id === projectId)?.name;

  return (
    <ScaffoldPage
      eyebrow="Triage inbox"
      title={projectName ?? "Sessions"}
      description="Newest first. Open a session to read its minute-long story, then prove you understood it."
    >
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

      {sessions.data && sessions.data.length > 0 ? (
        <div className="divide-y divide-dusk-hairline overflow-hidden rounded-dusk-card bg-dusk-surface">
          {sessions.data.map((session) => (
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
    </ScaffoldPage>
  );
}

// The inbox shows check status as-is: no "no check needed" derivation here.
// That display needs per-card data (only the story endpoint knows whether a
// session has anything worth checking), and list rows deliberately stay thin.
