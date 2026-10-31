import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

/** True when the server runs the baked read-only demo profile. */
export function useDemoMode(): { isDemo: boolean; isLoading: boolean } {
  const query = useQuery({
    queryKey: ["health"],
    queryFn: () => api.health(),
    // The mode never flips under a running server; fetch once per visit.
    staleTime: 30 * 60_000,
    retry: 1,
  });
  return { isDemo: query.data?.mode === "demo", isLoading: query.isPending };
}
