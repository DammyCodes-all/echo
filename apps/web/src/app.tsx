import { createBrowserRouter } from "react-router";
import { AppLayout } from "./layout";
import { DemoPage } from "./routes/demo";
import { HomePage } from "./routes/home";
import { NotFoundPage } from "./routes/not-found";
import { ProjectPage } from "./routes/project";
import { ProjectsPage } from "./routes/projects";
import { StoryPage } from "./routes/story";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "projects", element: <ProjectsPage /> },
      { path: "projects/:projectId", element: <ProjectPage /> },
      { path: "sessions/:sessionId", element: <StoryPage /> },
      { path: "demo", element: <DemoPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
