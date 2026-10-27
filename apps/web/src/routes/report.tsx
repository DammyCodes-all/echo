import { ScaffoldPage } from "../components/scaffold-page";

export function ReportPage() {
  return (
    <ScaffoldPage
      eyebrow="Report"
      title="What you reviewed, proved and waived"
      description="A report built from stored state: reviewed hunks, checks passed and failed, calibration, waivers and the capture gaps that limit the tape."
    >
      <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-8 text-sm text-zinc-400">
        Report generation is not wired up yet.
      </div>
    </ScaffoldPage>
  );
}
