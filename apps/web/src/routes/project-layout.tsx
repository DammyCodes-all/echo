import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useParams } from "react-router";
import { api } from "../api";
import { ScaffoldPage } from "../components/scaffold-page";

function tabClass({ isActive }: { isActive: boolean }) {
  return `rounded-dusk-pill px-3 py-1.5 text-sm transition-colors ${
    isActive ? "bg-dusk-pill text-dusk-ink" : "text-dusk-muted hover:text-dusk-ink"
  }`;
}

export function ProjectLayout() {
  const { projectId = "" } = useParams();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const projectName = projects.data?.find((project) => project.id === projectId)?.name ?? projectId;

  return (
    <ScaffoldPage
      eyebrow="Project workspace"
      title={projectName}
      description="Overview, learning, and architecture for this repository. Tapes never mix between projects."
    >
      <nav aria-label="Project sections" className="flex items-center gap-1">
        <NavLink to={`/projects/${projectId}/overview`} className={tabClass} end>
          Overview
        </NavLink>
        <NavLink to={`/projects/${projectId}/learn`} className={tabClass}>
          Learn
        </NavLink>
        <NavLink to={`/projects/${projectId}/architecture`} className={tabClass}>
          Architecture
        </NavLink>
      </nav>
      <Outlet />
    </ScaffoldPage>
  );
}
