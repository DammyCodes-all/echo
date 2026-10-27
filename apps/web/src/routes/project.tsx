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
        <div className="rounded-xl border border-red-900/60 bg-red-950/30 p-8 text-sm text-red-300">
          Could not load sessions.
        </div>
      ) : null}

      {sessions.data && sessions.data.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-8 text-sm text-zinc-400">
          No sessions captured for this project yet.
        </div>
      ) : null}

      {sessions.data && sessions.data.length > 0 ? (
        <div className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/30">
          {sessions.data.map((session) => (
            <Link
              key={session.id}
              to={`/sessions/${session.id}/replay`}
              className="flex flex-col gap-2 p-5 transition-colors hover:bg-zinc-900/60 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-100">
                  {session.title ?? session.id}
                </p>
                <p className="mt-1 font-mono text-xs text-zinc-500">
                  {session.id} ·{" "}
                  {session.startedAt ? formatTime(session.startedAt) : "unknown time"}
                </p>
              </div>
              <div className="flex items-center gap-3 text-xs text-zinc-400">
                <span className="rounded-full border border-zinc-700 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest">
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
