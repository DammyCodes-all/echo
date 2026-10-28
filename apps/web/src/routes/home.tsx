import { Navigate } from "react-router";

const LAST_PROJECT_KEY = "echo:lastProject";

export function HomePage() {
  let lastProject: string | null = null;
  try {
    lastProject = localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    lastProject = null;
  }
  if (lastProject) return <Navigate to={`/projects/${lastProject}`} replace />;
  return <Navigate to="/projects" replace />;
}
