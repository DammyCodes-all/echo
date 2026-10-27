import { ScaffoldPage } from "../components/scaffold-page";

export function ChecksPage() {
  return (
    <ScaffoldPage
      eyebrow="Understanding checks"
      title="Prove what you took in"
      description="Echo selects a few risky hunks, asks short questions about them, and runs the code to establish the reference behaviour. Confidence comes before the answer."
    >
      <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-8 text-sm text-zinc-400">
        Check generation, the sandbox gate and calibration are not wired up yet.
      </div>
    </ScaffoldPage>
  );
}
