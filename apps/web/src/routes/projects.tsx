import { ScaffoldPage } from "../components/scaffold-page";

export function ProjectsPage() {
  return (
    <ScaffoldPage
      eyebrow="Projects"
      title="No projects captured yet"
      description="Echo keeps a workspace per repository. Every recorded agent session for that repository lives under it, and tapes never mix between projects."
    >
      <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-8">
        <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">
          Waiting for a tape
        </p>
        <p className="mt-3 max-w-xl text-sm leading-6 text-zinc-400">
          Record an interactive Muse Code session from a repository and it will appear here with its
          timeline, file history and final diff.
        </p>
      </div>
    </ScaffoldPage>
  );
}
