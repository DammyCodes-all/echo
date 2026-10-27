import { ScaffoldPage } from "../components/scaffold-page";

export function ReportPage() {
  return (
    <ScaffoldPage
      eyebrow="Report"
      title="What you reviewed, proved and waived"
      description="A report built from stored state: reviewed hunks, checks passed and failed, calibration, waivers and the capture gaps that limit the tape."
    >
      <div className="rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
        Report generation is not wired up yet.
      </div>
    </ScaffoldPage>
  );
}
