import { ScaffoldPage } from "../components/scaffold-page";

export function ChecksPage() {
  return (
    <ScaffoldPage
      eyebrow="Understanding checks"
      title="Prove what you took in"
      description="Echo selects a few risky hunks, asks short questions about them, and runs the code to establish the reference behaviour. Confidence comes before the answer."
    >
      <div className="rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
        Check generation, the sandbox gate and calibration are not wired up yet.
      </div>
    </ScaffoldPage>
  );
}
