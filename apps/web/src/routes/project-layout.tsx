import { Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useLocation, useParams } from "react-router";
import { api } from "../api";
import { ProjectNavPill } from "../components/project-nav-pill";
import { ScaffoldPage } from "../components/scaffold-page";
import { displayProjectName } from "../project-display";

const SECTIONS = ["overview", "learn", "architecture"] as const;

export function ProjectLayout() {
  const { projectId = "" } = useParams();
  const location = useLocation();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const found = projects.data?.find((project) => project.id === projectId);
  const projectName = found
    ? displayProjectName(found)
    : displayProjectName({ name: null, root: projectId, id: projectId });

  const active = Math.max(
    0,
    SECTIONS.findIndex((section) => location.pathname.endsWith(`/${section}`)),
  );

  // ScaffoldPage takes a string title, so the pending branch inlines its
  // breadcrumb shell to show a skeleton bar where the title will land.
  if (projects.isPending) {
    return (
      <section className="space-y-8">
        <nav
          aria-label="Breadcrumb"
          className="sticky top-0 z-10 -mx-6 bg-dusk-base/95 px-6 py-3 backdrop-blur"
        >
          <div className="flex items-center gap-2 text-sm">
            <Link to="/projects" className="text-dusk-muted transition-colors hover:text-dusk-ink">
              ← Projects
            </Link>
            <span aria-hidden className="text-dusk-faint">
              /
            </span>
            <h1
              aria-current="page"
              className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-dusk-ink"
            >
              <span aria-hidden className="inline-flex text-dusk-muted">
                <HugeiconsIcon icon={Folder01Icon} size={22} strokeWidth={1.8} />
              </span>
              <span role="status" aria-label="Loading project">
                <span
                  aria-hidden
                  className="block h-8 w-56 rounded-dusk-code bg-dusk-pill motion-safe:animate-pulse"
                />
              </span>
            </h1>
          </div>
        </nav>
        <Outlet />
        <ProjectNavPill projectId={projectId} active={active} />
      </section>
    );
  }

  return (
    <ScaffoldPage breadcrumb={{ backTo: "/projects", backLabel: "Projects" }} title={projectName}>
      <Outlet />
      <ProjectNavPill projectId={projectId} active={active} />
    </ScaffoldPage>
  );
}
