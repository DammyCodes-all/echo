import { useQuery } from "@tanstack/react-query";
import { Outlet, useLocation, useParams } from "react-router";
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

  return (
    <ScaffoldPage breadcrumb={{ backTo: "/projects", backLabel: "Projects" }} title={projectName}>
      <Outlet />
      <ProjectNavPill projectId={projectId} active={active} />
    </ScaffoldPage>
  );
}
