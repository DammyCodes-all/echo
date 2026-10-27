import { createBrowserRouter } from "react-router";
import { AppLayout } from "./layout";
import { ChecksPage } from "./routes/checks";
import { DemoPage } from "./routes/demo";
import { NotFoundPage } from "./routes/not-found";
import { ProjectPage } from "./routes/project";
import { ProjectsPage } from "./routes/projects";
import { ReplayPage } from "./routes/replay";
import { ReportPage } from "./routes/report";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <ProjectsPage /> },
      { path: "projects/:projectId", element: <ProjectPage /> },
      { path: "sessions/:sessionId/replay", element: <ReplayPage /> },
      { path: "sessions/:sessionId/checks", element: <ChecksPage /> },
      { path: "sessions/:sessionId/report", element: <ReportPage /> },
      { path: "demo", element: <DemoPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
