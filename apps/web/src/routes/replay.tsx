import { Panel, ScaffoldPage } from "../components/scaffold-page";

export function ReplayPage() {
  return (
    <ScaffoldPage
      eyebrow="Session replay"
      title="Timeline, file state and diff"
      description="Scrub captured actions, inspect the file state at a moment, read the final diff, and ask about any hunk with answers tied to evidence on the tape."
    >
      <div className="grid gap-4 lg:grid-cols-[240px_1fr_320px]">
        <Panel label="Timeline" />
        <Panel label="File state and final diff" />
        <Panel label="Hunk inspector and ask" />
      </div>
    </ScaffoldPage>
  );
}
