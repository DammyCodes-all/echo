import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { ScaffoldPage } from "../components/scaffold-page";
import { getOpenedHunks } from "../opened-hunks";

export function ReportPage() {
  const { sessionId = "" } = useParams();
  const report = useQuery({
    queryKey: ["report", sessionId],
    queryFn: () => api.report(sessionId),
  });

  const opened = getOpenedHunks(sessionId);

  return (
    <ScaffoldPage
      eyebrow="Report"
      title="What you reviewed, proved and waived"
      description="A report built from stored state: reviewed hunks, checks passed and failed, calibration, waivers and the capture gaps that limit the tape."
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Link
          to={`/sessions/${sessionId}/checks`}
          className="rounded-dusk-code bg-dusk-pill px-4 py-2 text-sm text-dusk-ink"
        >
          Back to checks
        </Link>
        <Link
          to={`/sessions/${sessionId}/replay`}
          className="text-sm text-dusk-muted underline underline-offset-4"
        >
          Back to replay
        </Link>
      </div>

      {report.isPending ? (
        <div className="rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
          Loading report…
        </div>
      ) : null}
      {report.isError ? (
        <div className="rounded-dusk-card border border-dusk-fail/40 bg-dusk-fail-wash p-8 text-sm text-dusk-fail">
          Could not load the report.
        </div>
      ) : null}
      {report.data ? (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-4">
            {[
              { label: "Hunks", value: String(report.data.hunksTotal) },
              { label: "Opened", value: String(opened.length) },
              {
                label: "Answered",
                value: `${report.data.correct}/${report.data.answered} correct`,
              },
              { label: "Waived", value: String(report.data.waived.length) },
            ].map((stat) => (
              <div key={stat.label} className="rounded-dusk-card bg-dusk-surface px-6 py-5">
                <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
                  {stat.label}
                </p>
                <p className="mt-2 text-xl text-dusk-ink">{stat.value}</p>
              </div>
            ))}
          </div>

          <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
            <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
              Calibration
            </p>
            {report.data.calibration.meanBrier === null ? (
              <p className="mt-3 text-sm text-dusk-muted">No answers yet.</p>
            ) : (
              <div className="mt-3 space-y-2 text-sm text-dusk-ink">
                <p>
                  Mean Brier score: {report.data.calibration.meanBrier.toFixed(3)} (lower is better
                  calibrated).
                </p>
                <p
                  className={
                    report.data.calibration.overconfidenceCount > 0 ? "text-dusk-fail" : ""
                  }
                >
                  Wrong-and-certain answers: {report.data.calibration.overconfidenceCount}
                </p>
                <ul className="space-y-1 text-dusk-muted">
                  {report.data.calibration.perConfidence.map((row) => (
                    <li key={row.confidence} className="font-mono text-xs">
                      {row.confidence.replace("_", " ")}: {row.correct}/{row.answered} correct
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {report.data.waived.length > 0 ? (
            <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
              <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">Waived</p>
              <ul className="mt-3 space-y-1 font-mono text-xs text-dusk-muted">
                {report.data.waived.map((hunkId) => (
                  <li key={hunkId}>{hunkId}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {report.data.gaps.length > 0 ? (
            <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
              <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
                What the tape could not show
              </p>
              <ul className="mt-3 space-y-1 font-mono text-xs text-dusk-muted">
                {report.data.gaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </ScaffoldPage>
  );
}
