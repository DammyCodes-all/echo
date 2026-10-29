import { useQuery } from "@tanstack/react-query";
import { Outlet, useLocation, useParams } from "react-router";
import { api } from "../api";
import { ProjectNavPill } from "../components/project-nav-pill";
import { ScaffoldPage } from "../components/scaffold-page";

const SECTIONS = ["overview", "learn", "architecture"] as const;

export function ProjectLayout() {
  const { projectId = "" } = useParams();
  const location = useLocation();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const projectName = projects.data?.find((project) => project.id === projectId)?.name ?? projectId;

  const active = Math.max(
    0,
    SECTIONS.findIndex((section) => location.pathname.endsWith(`/${section}`)),
  );

  return (
    <ScaffoldPage
      eyebrow="Project workspace"
      title={projectName}
      description="Overview, learning, and architecture for this repository. Tapes never mix between projects."
    >
      <Outlet />
      <ProjectNavPill projectId={projectId} active={active} />
    </ScaffoldPage>
  );
}
