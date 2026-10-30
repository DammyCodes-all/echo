import { useEffect, useRef } from "react";

export type ArchitectureStreamEvent =
  | { type: "generation.progress"; stage: string; progress: number }
  | { type: "generation.done"; version: number; warnings: string[] }
  | { type: "generation.error"; message: string }
  | { type: "architecture.updated"; version: number };

function isStreamEvent(value: unknown): value is ArchitectureStreamEvent {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === "generation.progress" ||
    type === "generation.done" ||
    type === "generation.error" ||
    type === "architecture.updated"
  );
}

/** One EventSource per project; the handler ref never reconnects the socket. */
export function useArchitectureStream(
  projectId: string,
  onEvent: (event: ArchitectureStreamEvent) => void,
): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    const source = new EventSource(
      `/api/projects/${encodeURIComponent(projectId)}/architecture/stream`,
    );
    source.onmessage = (message) => {
      try {
        const parsed: unknown = JSON.parse(message.data as string);
        if (isStreamEvent(parsed)) handler.current(parsed);
      } catch {
        // Malformed frame: ignore, the next event still lands.
      }
    };
    return () => {
      source.close();
    };
  }, [projectId]);
}
