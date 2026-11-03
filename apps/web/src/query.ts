import type { QueryClient } from "@tanstack/react-query";
import { api } from "./api";

/**
 * Every cache key in one place so reads, prefetches, and invalidations can
 * never drift apart. Shapes match the keys already in use, so cached data
 * survives the migration.
 */
export const queryKeys = {
  health: ["health"],
  projects: ["projects"],
  project: (projectId: string) => ["project", projectId],
  sessions: (projectId: string) => ["sessions", projectId],
  session: (sessionId: string) => ["session", sessionId],
  changes: (sessionId: string) => ["changes", sessionId],
  code: (sessionId: string, changeId: string) => ["code", sessionId, changeId],
  checks: (sessionId: string) => ["checks", sessionId],
  askThread: (sessionId: string) => ["ask-thread", sessionId],
  learn: (projectId: string) => ["learn", projectId],
  architecture: (projectId: string) => ["architecture", projectId],
  techStack: (projectId: string) => ["tech-stack", projectId],
} as const;

/** Shadow-git diffs never change: fetch once per change, keep for the visit. */
export const IMMUTABLE_STALE_TIME = Number.POSITIVE_INFINITY;

/** Warm the reader behind a hovered session card: header row + change list. */
export function prefetchReader(queryClient: QueryClient, sessionId: string): void {
  void queryClient.prefetchQuery({
    queryKey: queryKeys.session(sessionId),
    queryFn: () => api.session(sessionId),
  });
  void queryClient.prefetchQuery({
    queryKey: queryKeys.changes(sessionId),
    queryFn: () => api.changes(sessionId),
  });
}

/** Warm one diff. Immutable, so a hover-fill never triggers a refetch. */
export function prefetchCode(queryClient: QueryClient, sessionId: string, changeId: string): void {
  void queryClient.prefetchQuery({
    queryKey: queryKeys.code(sessionId, changeId),
    queryFn: () => api.changeCode(sessionId, changeId),
    staleTime: IMMUTABLE_STALE_TIME,
  });
}

/** Warm the project overview behind a hovered folder: row + sessions + stack. */
export function prefetchProject(queryClient: QueryClient, projectId: string): void {
  void queryClient.prefetchQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.project(projectId),
  });
  void queryClient.prefetchQuery({
    queryKey: queryKeys.sessions(projectId),
    queryFn: () => api.sessions(projectId),
  });
  void queryClient.prefetchQuery({
    queryKey: queryKeys.techStack(projectId),
    queryFn: () => api.techStack(projectId),
  });
}
