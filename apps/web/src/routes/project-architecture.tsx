import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { api, formatTime } from "../api";

export function ProjectArchitecturePage() {
  const { projectId = "" } = useParams();
  const files = useQuery({
    queryKey: ["project-files", projectId],
    queryFn: () => api.projectFiles(projectId),
  });

  if (files.isPending) {
    return (
      <div className="rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
        Loading touched files…
      </div>
    );
  }

  if (files.isError) {
    return (
      <div className="rounded-dusk-card border border-dusk-fail/40 bg-dusk-fail-wash p-8 text-sm text-dusk-fail">
        Could not load architecture data.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold tracking-tight">Where the agent has worked</h2>
      <p className="max-w-2xl text-sm leading-6 text-dusk-muted">
        Agent-touched overlay from shadow snapshots — no model summary. The full import graph is
        still cut; this table answers “which files keep changing” from evidence alone.
      </p>
      {files.data.files.length === 0 ? (
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
    </div>
  );
}
