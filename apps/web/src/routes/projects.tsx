import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { ProjectFolderCard } from "../components/project-folder-card";
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
        <div className="rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
          Loading projects…
        </div>
      ) : null}

      {projects.isError ? (
        <div className="rounded-dusk-card border border-dusk-fail/40 bg-dusk-fail-wash p-8 text-sm text-dusk-fail">
          Could not reach the daemon. Is it running on 127.0.0.1:4783?
        </div>
      ) : null}

      {projects.data && projects.data.length === 0 ? (
        <div className="rounded-dusk-card bg-dusk-surface p-8">
          <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
            Waiting for a tape
          </p>
          <p className="mt-3 max-w-xl text-sm leading-6 text-dusk-muted">
            Enable a repository with{" "}
            <code className="rounded-dusk-code bg-dusk-pill px-1.5 py-0.5 font-mono text-xs text-dusk-ink">
              echo-cli enable &lt;path&gt;
            </code>{" "}
            and run an OpenCode session in it. Echo will pick the session up on its next poll.
          </p>
        </div>
      ) : null}

      {projects.data && projects.data.length > 0 ? (
        <div className="grid justify-items-center gap-x-4 gap-y-10 md:grid-cols-2">
          {projects.data.map((project, index) => (
            <ProjectFolderCard key={project.id} project={project} index={index} />
          ))}
        </div>
      ) : null}
    </ScaffoldPage>
  );
}
