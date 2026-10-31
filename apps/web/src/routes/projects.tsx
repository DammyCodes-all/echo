import type { ProjectSummary } from "@echo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api";
import { ProjectFolderCard } from "../components/project-folder-card";
import { ScaffoldPage } from "../components/scaffold-page";
import type { SortKey } from "../components/search/project-sort";
import { ProjectFolderSkeleton } from "../components/skeleton";
import { displayProjectName } from "../project-display";

function matchesQuery(project: ProjectSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const haystacks = [displayProjectName(project), project.root, project.remoteUrl ?? ""];
  return haystacks.some((hay) => hay.toLowerCase().includes(q));
}

function compareProjects(a: ProjectSummary, b: ProjectSummary, sort: SortKey): number {
  const byName = displayProjectName(a).localeCompare(displayProjectName(b));
  if (sort === "name") return byName;
  if (sort === "sessions") return b.sessionCount - a.sessionCount || byName;
  if (a.lastActivity === null && b.lastActivity === null) return byName;
  if (a.lastActivity === null) return 1;
  if (b.lastActivity === null) return -1;
  return Date.parse(b.lastActivity) - Date.parse(a.lastActivity) || byName;
}

export function ProjectsPage() {
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: api.projects,
    refetchInterval: 5000,
  });
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const rawSort = searchParams.get("sort");
  const sort: SortKey = rawSort === "name" || rawSort === "sessions" ? rawSort : "activity";

  // The header search drives the filter through `?q=`; stay in sync when it
  // (or history navigation) changes the param under us.
  useEffect(() => {
    const q = searchParams.get("q") ?? "";
    setQuery((prev) => (prev === q ? prev : q));
  }, [searchParams]);

  function changeQuery(next: string): void {
    setQuery(next);
    setSearchParams(next === "" ? {} : { q: next }, { replace: true });
  }

  const visible = useMemo(() => {
    const list = (projects.data ?? []).filter((project) => matchesQuery(project, query));
    return [...list].sort((a, b) => compareProjects(a, b, sort));
  }, [projects.data, query, sort]);

  const filtering = query.trim().length > 0;

  return (
    <ScaffoldPage
      title="Captured repositories"
      description="Echo keeps a workspace per repository. Every recorded agent session for that repository lives under it, and tapes never mix between projects."
    >
      {projects.isPending ? (
        <div
          role="status"
          aria-label="Loading projects"
          className="grid grid-cols-[auto] justify-center justify-items-center gap-x-4 gap-y-10 md:grid-cols-[repeat(2,auto)] md:justify-between xl:grid-cols-[repeat(3,auto)]"
        >
          <span className="sr-only">Loading projects…</span>
          {["skeleton-a", "skeleton-b", "skeleton-c"].map((id) => (
            <ProjectFolderSkeleton key={id} />
          ))}
        </div>
      ) : null}

      {projects.isError ? (
        <div className="rounded-dusk-card border border-dusk-fail/40 bg-dusk-fail-wash p-8 text-sm text-dusk-fail">
          Could not reach the daemon. Is it running on 127.0.0.1:4783?
        </div>
      ) : null}

      {projects.data && projects.data.length === 0 ? (
        <div className="rounded-dusk-card bg-dusk-surface p-8">
          <p className="text-xs uppercase tracking-widest text-dusk-muted">Waiting for a tape</p>
          <p className="mt-3 max-w-xl text-sm leading-6 text-dusk-muted">
            Enable a repository with{" "}
            <code className="rounded-dusk-code bg-dusk-pill px-1.5 py-0.5 font-mono text-xs text-dusk-ink">
              echo-cli enable &lt;path&gt;
            </code>{" "}
            and run an OpenCode session in it. Echo will pick the session up on its next poll.
          </p>
        </div>
      ) : null}

      {filtering && projects.data && projects.data.length > 0 ? (
        <p className="mb-4 text-sm text-dusk-muted" role="status">
          {visible.length} of {projects.data.length} project{projects.data.length === 1 ? "" : "s"}
        </p>
      ) : null}

      {visible.length > 0 ? (
        <div className="grid grid-cols-[auto] justify-center justify-items-center gap-x-4 gap-y-10 md:grid-cols-[repeat(2,auto)] md:justify-between xl:grid-cols-[repeat(3,auto)]">
          {visible.map((project, index) => (
            <ProjectFolderCard key={project.id} project={project} index={index} />
          ))}
        </div>
      ) : null}

      {projects.data && projects.data.length > 0 && visible.length === 0 ? (
        <div className="rounded-dusk-card bg-dusk-surface p-8">
          <p className="text-sm text-dusk-muted">No projects match “{query.trim()}”.</p>
          <button
            type="button"
            onClick={() => changeQuery("")}
            className="mt-3 rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm font-semibold text-dusk-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent"
          >
            Clear search
          </button>
        </div>
      ) : null}
    </ScaffoldPage>
  );
}
