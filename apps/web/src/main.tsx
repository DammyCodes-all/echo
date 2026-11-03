import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { router } from "./app";
import { DiffWorkerProvider } from "./components/diff-worker-provider";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // SWR behavior: cached data paints instantly on back-navigation while a
      // stale mount revalidates in the background. isPending is only true
      // with no cached data, so skeletons show on first load, never revisit.
      // Live lists keep their own refetchInterval; window-focus refetch would
      // only double that churn.
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DiffWorkerProvider>
        <RouterProvider router={router} />
      </DiffWorkerProvider>
    </QueryClientProvider>
  </StrictMode>,
);
