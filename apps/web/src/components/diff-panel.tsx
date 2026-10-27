import type { SnapshotFile } from "@echo/contracts";
import type { Hunk } from "@pierre/diffs";
import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { api } from "../api";

export interface ChangedPath {
  path: string;
  oldFile: SnapshotFile | undefined;
  newFile: SnapshotFile | undefined;
}

function changedPaths(oldFiles: SnapshotFile[], newFiles: SnapshotFile[]): ChangedPath[] {
  const oldByPath = new Map(oldFiles.map((file) => [file.path, file]));
  const newByPath = new Map(newFiles.map((file) => [file.path, file]));
  const paths = [...new Set([...oldByPath.keys(), ...newByPath.keys()])].sort();
  return paths
    .map((path) => ({ path, oldFile: oldByPath.get(path), newFile: newByPath.get(path) }))
    .filter(
      ({ oldFile, newFile }) =>
        oldFile?.sha256 !== newFile?.sha256 || oldFile?.blobOid !== newFile?.blobOid,
    );
}

function FileDiffView({
  sessionId,
  oldCommit,
  newCommit,
  entry,
  selected,
  onSelect,
  onHunks,
}: {
  sessionId: string;
  oldCommit: string;
  newCommit: string;
  entry: ChangedPath;
  selected: boolean;
  onSelect: (path: string | null) => void;
  onHunks: (path: string, hunks: Hunk[]) => void;
}) {
  const { path, oldFile, newFile } = entry;
  const comparable = oldFile?.captured !== false || newFile?.captured !== false;
  const oldContent = useQuery({
    queryKey: ["snapshot-blob", sessionId, oldCommit, path],
    queryFn: () => api.fileContent(sessionId, oldCommit, path),
    enabled: comparable && oldFile?.captured === true,
  });
  const newContent = useQuery({
    queryKey: ["snapshot-blob", sessionId, newCommit, path],
    queryFn: () => api.fileContent(sessionId, newCommit, path),
    enabled: comparable && newFile?.captured === true,
  });

  const fileDiff = useMemo(() => {
    if (!comparable) return null;
    if (oldFile?.captured === true && oldContent.data === undefined) return null;
    if (newFile?.captured === true && newContent.data === undefined) return null;
    return parseDiffFromFile(
      oldFile?.captured === true && oldContent.data
        ? { name: path, contents: oldContent.data.content }
        : null,
      newFile?.captured === true && newContent.data
        ? { name: path, contents: newContent.data.content }
        : null,
    );
  }, [comparable, oldFile, newFile, oldContent.data, newContent.data, path]);

  useEffect(() => {
    if (fileDiff) onHunks(path, fileDiff.hunks);
  }, [fileDiff, onHunks, path]);

  if (!comparable) {
    return (
      <p className="px-6 py-3 font-mono text-[11px] text-dusk-muted">
        {path} — not comparable ({oldFile?.reason ?? newFile?.reason ?? "uncaptured"})
      </p>
    );
  }
  if (oldContent.isPending || newContent.isPending || !fileDiff) {
    return <p className="px-6 py-3 font-mono text-[11px] text-dusk-muted">{path} — loading…</p>;
  }
  if (oldContent.isError || newContent.isError) {
    return (
      <p className="px-4 py-2 font-mono text-[11px] text-dusk-fail">{path} — failed to load</p>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onSelect(selected ? null : path)}
      className={`block w-full text-left ${selected ? "outline outline-1 outline-dusk-accent" : ""}`}
    >
      <FileDiff fileDiff={fileDiff} options={{ theme: "pierre-dark", diffStyle: "unified" }} />
    </button>
  );
}

export function DiffPanel({
  sessionId,
  selectedPath,
  onSelectPath,
  onHunks,
}: {
  sessionId: string;
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
  onHunks: (path: string, hunks: Hunk[]) => void;
}) {
  const snapshots = useQuery({
    queryKey: ["snapshots", sessionId],
    queryFn: () => api.snapshots(sessionId),
  });
  const oldCommit = snapshots.data?.[0]?.commitOid ?? null;
  const newCommit =
    snapshots.data && snapshots.data.length > 1 ? (snapshots.data.at(-1)?.commitOid ?? null) : null;

  const oldFiles = useQuery({
    queryKey: ["snapshot-files", sessionId, oldCommit],
    queryFn: () => api.snapshotFiles(sessionId, oldCommit as string),
    enabled: oldCommit !== null,
  });
  const newFiles = useQuery({
    queryKey: ["snapshot-files", sessionId, newCommit],
    queryFn: () => api.snapshotFiles(sessionId, newCommit as string),
    enabled: newCommit !== null,
  });

  const changed = useMemo(
    () => (oldFiles.data && newFiles.data ? changedPaths(oldFiles.data, newFiles.data) : null),
    [oldFiles.data, newFiles.data],
  );
  const visible =
    selectedPath && changed ? changed.filter((entry) => entry.path === selectedPath) : changed;

  return (
    <section aria-label="Diff" className="rounded-dusk-card bg-dusk-surface">
      <div className="flex items-center justify-between border-b border-dusk-hairline px-6 py-4">
        <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
          Diff · first to final snapshot
        </p>
        {selectedPath ? (
          <button
            type="button"
            onClick={() => onSelectPath(null)}
            className="font-mono text-[11px] text-dusk-accent hover:text-dusk-accent-soft"
          >
            show all
          </button>
        ) : null}
      </div>

      {snapshots.isPending || oldFiles.isPending || newFiles.isPending ? (
        <p className="p-6 text-sm text-dusk-muted">Loading diff…</p>
      ) : null}
      {snapshots.data && snapshots.data.length < 2 ? (
        <p className="p-6 text-sm text-dusk-muted">
          The diff needs two snapshots; this session has {snapshots.data.length}.
        </p>
      ) : null}
      {changed && changed.length === 0 ? (
        <p className="p-6 text-sm text-dusk-muted">No file changes between the snapshots.</p>
      ) : null}

      {visible && oldCommit && newCommit
        ? visible.map((entry) => (
            <FileDiffView
              key={entry.path}
              sessionId={sessionId}
              oldCommit={oldCommit}
              newCommit={newCommit}
              entry={entry}
              selected={entry.path === selectedPath}
              onSelect={onSelectPath}
              onHunks={onHunks}
            />
          ))
        : null}
    </section>
  );
}
