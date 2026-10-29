import type { ProjectSummary } from "@echo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api";
import { ProjectFolderCard } from "../components/project-folder-card";
import { ScaffoldPage } from "../components/scaffold-page";
import { Skeleton } from "../components/skeleton";
import { displayProjectName } from "../project-display";

type SortKey = "activity" | "name" | "sessions";

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "activity", label: "Last activity" },
  { value: "name", label: "Name" },
  { value: "sessions", label: "Sessions" },
];

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
  const [sort, setSort] = useState<SortKey>("activity");

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
      eyebrow="Projects"
      title="Captured repositories"
      description="Echo keeps a workspace per repository. Every recorded agent session for that repository lives under it, and tapes never mix between projects."
    >
      {projects.isPending ? (
        <div
          role="status"
          aria-label="Loading projects"
          className="grid justify-items-center gap-x-4 gap-y-10 md:grid-cols-2"
        >
          <span className="sr-only">Loading projects…</span>
          {["skeleton-a", "skeleton-b", "skeleton-c", "skeleton-d"].map((id) => (
            <div
              key={id}
              aria-hidden
              className="h-[200px] w-full max-w-[320px] rounded-dusk-card bg-dusk-surface p-6"
            >
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="mt-3 h-3.5" />
              <Skeleton className="mt-2 h-3.5 w-4/5" />
            </div>
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
        <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <label htmlFor="project-search" className="sr-only">
            Search projects
          </label>
          <input
            id="project-search"
            type="search"
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            placeholder="Search by name, path, or remote…"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink outline-none placeholder:text-dusk-muted"
          />
          <div className="flex shrink-0 items-center gap-2">
            <label htmlFor="project-sort" className="text-sm text-dusk-muted">
              Sort
            </label>
            <select
              id="project-sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
              className="rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink outline-none"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
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
