import { createBrowserRouter, Navigate } from "react-router";
import { AppLayout } from "./layout";
import { DemoPage } from "./routes/demo";
import { NotFoundPage } from "./routes/not-found";
import { ProjectArchitecturePage } from "./routes/project-architecture";
import { ProjectLayout } from "./routes/project-layout";
import { ProjectLearnPage } from "./routes/project-learn";
import { ProjectOverviewPage } from "./routes/project-overview";
import { ProjectsPage } from "./routes/projects";
import { StoryPage } from "./routes/story";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <ProjectsPage /> },
      { path: "projects", element: <ProjectsPage /> },
      {
        path: "projects/:projectId",
        element: <ProjectLayout />,
        children: [
          { index: true, element: <Navigate to="overview" replace /> },
          { path: "overview", element: <ProjectOverviewPage /> },
          { path: "learn", element: <ProjectLearnPage /> },
          { path: "architecture", element: <ProjectArchitecturePage /> },
        ],
      },
      { path: "sessions/:sessionId", element: <StoryPage /> },
      { path: "demo", element: <DemoPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
