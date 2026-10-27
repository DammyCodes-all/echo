import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, formatTime } from "../api";
import { ScaffoldPage } from "../components/scaffold-page";

export function ProjectsPage() {
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: api.projects,
    refetchInterval: 5000,
  });

  return (
    <ScaffoldPage
      eyebrow="Projects"
      title="Captured repositories"
      description="Echo keeps a workspace per repository. Every recorded agent session for that repository lives under it, and tapes never mix between projects."
    >
      {projects.isPending ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-8 text-sm text-zinc-400">
          Loading projects…
        </div>
      ) : null}

      {projects.isError ? (
        <div className="rounded-xl border border-red-900/60 bg-red-950/30 p-8 text-sm text-red-300">
          Could not reach the daemon. Is it running on 127.0.0.1:4783?
        </div>
      ) : null}

      {projects.data && projects.data.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-8">
          <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">
            Waiting for a tape
          </p>
          <p className="mt-3 max-w-xl text-sm leading-6 text-zinc-400">
            Enable a repository with{" "}
            <code className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-xs text-zinc-200">
              echo-cli enable &lt;path&gt;
            </code>{" "}
            and run an OpenCode session in it. Echo will pick the session up on its next poll.
          </p>
        </div>
      ) : null}

      {projects.data && projects.data.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {projects.data.map((project) => (
            <Link
              key={project.id}
              to={`/projects/${project.id}`}
              className="group rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 transition-colors hover:border-zinc-600"
            >
              <p className="text-base font-medium text-zinc-100 group-hover:text-white">
                {project.name ?? project.root}
              </p>
              <p className="mt-1 truncate font-mono text-xs text-zinc-500">{project.root}</p>
              <p className="mt-4 text-xs text-zinc-400">
                {project.sessionCount} session{project.sessionCount === 1 ? "" : "s"}
                {project.lastActivity ? ` · last activity ${formatTime(project.lastActivity)}` : ""}
              </p>
            </Link>
          ))}
        </div>
      ) : null}
    </ScaffoldPage>
  );
}
