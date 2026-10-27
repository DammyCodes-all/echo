import { ScaffoldPage } from "../components/scaffold-page";

export function DemoPage() {
  return (
    <ScaffoldPage
      eyebrow="Hosted demo"
      title="Replay a baked tape"
      description="The read-only demo runs the same review UI against one recorded session, so nobody has to install anything to try the loop."
    >
      <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-8 text-sm text-zinc-400">
        The baked demo tape and read-only deployment are not ready yet.
      </div>
    </ScaffoldPage>
  );
}
