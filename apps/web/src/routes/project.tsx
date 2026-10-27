import { ScaffoldPage } from "../components/scaffold-page";

export function ProjectPage() {
  return (
    <ScaffoldPage
      eyebrow="Project view"
      title="Sessions and agent activity"
      description="Sessions for this repository, the JavaScript and TypeScript import graph, and an overlay of the files the agent touched across sessions."
    >
      <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-8 text-sm text-zinc-400">
        Project sessions and the dependency map are not wired up yet.
      </div>
    </ScaffoldPage>
  );
}
