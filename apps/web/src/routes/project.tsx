import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api, formatTime } from "../api";
import { ScaffoldPage } from "../components/scaffold-page";

export function ProjectPage() {
  const { projectId = "" } = useParams();
  const sessions = useQuery({
    queryKey: ["sessions", projectId],
    queryFn: () => api.sessions(projectId),
    refetchInterval: 5000,
  });

  return (
    <ScaffoldPage
      eyebrow="Project view"
      title="Sessions in this repository"
      description="Each captured agent session for this repository, newest first. Project-level graphs and the attempt tree come later."
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
              to={`/sessions/${session.id}/replay`}
              className="flex flex-col gap-2 px-6 py-5 transition-colors hover:bg-dusk-pill/60 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate font-medium text-dusk-body text-dusk-ink">
                  {session.title ?? session.id}
                </p>
                <p className="mt-1 font-mono text-xs text-dusk-muted">
                  {session.id} ·{" "}
                  {session.startedAt ? formatTime(session.startedAt) : "unknown time"}
                </p>
              </div>
              <div className="flex items-center gap-3 text-xs text-dusk-muted">
                <span className="rounded-dusk-pill border border-dusk-hairline-strong px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest">
                  {session.captureQuality}
                </span>
                <span>{session.eventCount} events</span>
              </div>
            </Link>
          ))}
        </div>
      ) : null}
    </ScaffoldPage>
  );
}
