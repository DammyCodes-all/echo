import type { ArchitecturePatch } from "@echo/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router";
import { api, formatTime } from "../api";
import { ArchitectureChat } from "../components/architecture/architecture-chat";
import {
  ArchitectureDiagram,
  type PinnedNode,
} from "../components/architecture/architecture-diagram";
import { Skeleton } from "../components/skeleton";
import { useArchitectureStream } from "../hooks/use-architecture-stream";

function patchNodeIds(patch: ArchitecturePatch): string[] {
  const ids = new Set<string>();
  for (const op of patch) {
    switch (op.op) {
      case "addNode":
        ids.add(op.node.id);
        break;
      case "updateNode":
      case "removeNode":
        ids.add(op.id);
        break;
      case "addEdge":
        ids.add(op.edge.from);
        ids.add(op.edge.to);
        break;
      case "removeEdge":
        ids.add(op.from);
        ids.add(op.to);
        break;
      case "addGroup":
        break;
    }
  }
  return [...ids];
}

export function ProjectArchitecturePage() {
  const { projectId = "" } = useParams();
  const queryClient = useQueryClient();
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ stage: string; progress: number } | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [highlightedIds, setHighlightedIds] = useState<string[]>([]);
  const [pulseIds, setPulseIds] = useState<string[]>([]);
  const [pinned, setPinned] = useState<PinnedNode | null>(null);

  const arch = useQuery({
    queryKey: ["architecture", projectId],
    queryFn: () => api.architecture(projectId),
  });
  const files = useQuery({
    queryKey: ["project-files", projectId],
    queryFn: () => api.projectFiles(projectId),
  });

  useArchitectureStream(projectId, (event) => {
    switch (event.type) {
      case "generation.progress":
        setProgress({ stage: event.stage, progress: event.progress });
        break;
      case "generation.done":
      case "architecture.updated":
        setGenerating(false);
        setProgress(null);
        setGenerateError(null);
        void queryClient.invalidateQueries({ queryKey: ["architecture", projectId] });
        break;
      case "generation.error":
        setGenerating(false);
        setProgress(null);
        setGenerateError(event.message);
        break;
    }
  });

  const generate = useMutation({
    mutationFn: () => api.generateArchitecture(projectId),
    onMutate: () => {
      setGenerateError(null);
      setGenerating(true);
      setProgress({ stage: "starting", progress: 0 });
    },
    onError: (error) => {
      setGenerating(false);
      setProgress(null);
      setGenerateError(error instanceof Error ? error.message : "Generation failed.");
    },
  });

  const undo = useMutation({
    mutationFn: () => api.undoArchitecture(projectId),
    onMutate: () => setUndoError(null),
    onSuccess: () => {
      setPulseIds([]);
      void queryClient.invalidateQueries({ queryKey: ["architecture", projectId] });
    },
    onError: (error) => {
      setUndoError(error instanceof Error ? error.message : "Undo failed.");
    },
  });

  const onPatched = (patch: ArchitecturePatch) => {
    setPulseIds(patchNodeIds(patch));
    window.setTimeout(() => setPulseIds([]), 3000);
  };

  const architecture = arch.data?.architecture ?? null;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">System at a glance</h2>
            <p className="max-w-2xl text-sm leading-6 text-dusk-muted">
              Functional map of the whole project, generated from the code and docs — not a file
              tree. Hover a part for detail, click to pin it for the chat.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {architecture ? (
              <span className="font-mono text-xs text-dusk-muted">
                v{architecture.version} · {formatTime(architecture.generatedAt)}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => undo.mutate()}
              disabled={undo.isPending || !architecture || architecture.version <= 1}
              className="rounded-dusk-pill bg-dusk-secondary px-4 py-2 text-sm font-semibold text-dusk-accent-soft transition-opacity disabled:opacity-50"
            >
              {undo.isPending ? "Undoing…" : "Undo"}
            </button>
            <button
              type="button"
              onClick={() => generate.mutate()}
              disabled={generate.isPending || generating || arch.isPending}
              className="rounded-dusk-pill bg-dusk-accent px-4 py-2 text-sm font-semibold text-dusk-base transition-opacity disabled:opacity-50"
            >
              {architecture ? "Regenerate" : "Generate architecture"}
            </button>
          </div>
        </div>
        {undoError ? <p className="text-sm text-dusk-fail">{undoError}</p> : null}

        {arch.isPending ? (
          <div
            role="status"
            aria-label="Loading architecture"
            className="grid h-[520px] place-items-center rounded-dusk-card bg-dusk-surface"
          >
            <span className="sr-only">Loading architecture…</span>
            <Skeleton className="h-6 w-48" />
          </div>
        ) : arch.isError ? (
          <div className="space-y-3 rounded-dusk-card border border-dusk-fail/40 bg-dusk-fail-wash p-8 text-sm text-dusk-fail">
            <p>Could not load architecture data.</p>
            <button
              type="button"
              onClick={() => arch.refetch()}
              className="rounded-dusk-pill bg-dusk-secondary px-4 py-2 font-semibold text-dusk-accent-soft"
            >
              Retry
            </button>
          </div>
        ) : architecture === null && !generating ? (
          <div className="space-y-3 rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
            <p>
              No architecture map yet. Generate one from the project&apos;s code, README and docs.
            </p>
            <button
              type="button"
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
              className="rounded-dusk-pill bg-dusk-accent px-4 py-2 font-semibold text-dusk-base transition-opacity disabled:opacity-50"
            >
              Generate architecture
            </button>
          </div>
        ) : generating || generate.isPending ? (
          <div
            role="status"
            className="space-y-3 rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted"
          >
            <p>Generating the map{progress ? ` — ${progress.stage}` : ""}…</p>
            <div className="h-2 overflow-hidden rounded-dusk-pill bg-dusk-track">
              <div
                className="h-full rounded-dusk-pill bg-dusk-accent transition-[width]"
                style={{ width: `${Math.round((progress?.progress ?? 0) * 100)}%` }}
              />
            </div>
          </div>
        ) : architecture ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
            <ArchitectureDiagram
              architecture={architecture}
              evidence={arch.data?.evidence ?? {}}
              highlightedIds={highlightedIds}
              pulseIds={pulseIds}
              pinnedId={pinned?.id ?? null}
              onPin={setPinned}
            />
            <ArchitectureChat
              projectId={projectId}
              pinned={pinned}
              onClearPin={() => setPinned(null)}
              onHighlight={setHighlightedIds}
              onPatched={onPatched}
            />
          </div>
        ) : null}
        {generateError ? <p className="text-sm text-dusk-fail">{generateError}</p> : null}
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold tracking-tight">Where the agent has worked</h2>
        <p className="max-w-2xl text-sm leading-6 text-dusk-muted">
          Agent-touched overlay from shadow snapshots — no model summary. The full import graph is
          still cut; this table answers “which files keep changing” from evidence alone.
        </p>
        {files.isPending ? (
          <div
            role="status"
            aria-label="Loading touched files"
            className="overflow-hidden rounded-dusk-card bg-dusk-surface"
          >
            <span className="sr-only">Loading touched files…</span>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-dusk-hairline font-mono text-[10px] uppercase tracking-widest text-dusk-muted">
                  <th className="px-6 py-3 font-medium">File</th>
                  <th className="px-6 py-3 font-medium">Sessions</th>
                  <th className="px-6 py-3 font-medium">Last touched</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dusk-hairline">
                {[0, 1, 2, 3, 4, 5].map((slot) => (
                  <tr key={slot}>
                    <td className="px-6 py-3">
                      <Skeleton className="h-3.5 w-3/4" />
                    </td>
                    <td className="px-6 py-3">
                      <Skeleton className="h-3.5 w-10" />
                    </td>
                    <td className="px-6 py-3">
                      <Skeleton className="h-3.5 w-24" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : files.isError ? (
          <div className="rounded-dusk-card border border-dusk-fail/40 bg-dusk-fail-wash p-8 text-sm text-dusk-fail">
            Could not load architecture data.
          </div>
        ) : files.data.files.length === 0 ? (
          <div className="rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
            No captured file changes for this project yet.
          </div>
        ) : (
          <div className="overflow-hidden rounded-dusk-card bg-dusk-surface">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-dusk-hairline font-mono text-[10px] uppercase tracking-widest text-dusk-muted">
                  <th className="px-6 py-3 font-medium">File</th>
                  <th className="px-6 py-3 font-medium">Sessions</th>
                  <th className="px-6 py-3 font-medium">Last touched</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dusk-hairline">
                {files.data.files.map((file) => (
                  <tr key={file.path}>
                    <td className="px-6 py-3 font-mono text-xs text-dusk-ink">{file.path}</td>
                    <td className="px-6 py-3 text-dusk-muted">{file.sessionCount}</td>
                    <td className="px-6 py-3 font-mono text-xs text-dusk-muted">
                      {formatTime(file.lastTouched)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {files.data.truncated ? (
              <p className="px-6 py-3 font-mono text-xs text-dusk-muted">
                List truncated at 500 files.
              </p>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
