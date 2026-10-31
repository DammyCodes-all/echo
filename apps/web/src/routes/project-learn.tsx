import { capStorySummary } from "@echo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { compactSessionSummary } from "../session-display";

const BUCKET_LABELS: Record<string, string> = {
  solid: "Solid",
  right_but_unsure: "Right but unsure",
  confident_but_wrong: "Confident but wrong",
  wrong_and_knew_it: "Wrong and knew it",
  never_looked: "Never looked",
};

const BUCKET_ORDER = [
  "confident_but_wrong",
  "wrong_and_knew_it",
  "right_but_unsure",
  "solid",
  "never_looked",
];

export function ProjectLearnPage() {
  const { projectId = "" } = useParams();
  const learn = useQuery({ queryKey: ["learn", projectId], queryFn: () => api.learn(projectId) });

  if (learn.isPending) {
    return (
      <div role="status" aria-label="Loading calibration history" className="space-y-4">
        <div
          aria-hidden
          className="rounded-dusk-card bg-dusk-surface p-8 motion-safe:animate-pulse"
        >
          <div className="h-4 w-48 rounded-dusk-code bg-dusk-pill" />
          <div className="mt-3 h-3.5 w-3/4 rounded-dusk-code bg-dusk-pill" />
        </div>
        <div
          aria-hidden
          className="rounded-dusk-card bg-dusk-surface p-8 motion-safe:animate-pulse"
        >
          <div className="h-4 w-40 rounded-dusk-code bg-dusk-pill" />
        </div>
      </div>
    );
  }

  if (learn.isError) {
    return (
      <div className="rounded-dusk-card border border-dusk-fail/40 bg-dusk-fail-wash p-8 text-sm text-dusk-fail">
        Could not load calibration history.
      </div>
    );
  }

  const data = learn.data;
  if (data.checkedCount === 0 && data.nextUp.length === 0) {
    return (
      <div className="rounded-dusk-card bg-dusk-surface p-8">
        <p className="text-xs uppercase tracking-widest text-dusk-muted">Learn</p>
        <p className="mt-3 max-w-xl text-sm leading-6 text-dusk-muted">
          No checks yet. Open a session, read its story, and take the understanding check there —
          this page collects the picture once checks land.
        </p>
        <Link
          to={`/projects/${encodeURIComponent(projectId)}/overview`}
          className="mt-4 inline-block rounded-dusk-code bg-dusk-pill px-3 py-1.5 text-xs text-dusk-ink transition-colors hover:text-dusk-accent-soft"
        >
          Back to sessions
        </Link>
      </div>
    );
  }

  const totalCards = Object.values(data.bucketTotals).reduce((sum, count) => sum + count, 0);

  return (
    <div className="space-y-6">
      {data.nextUp.length > 0 ? (
        <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
          <p className="text-xs uppercase tracking-widest text-dusk-muted">Next up</p>
          <ul className="mt-3 space-y-2 text-sm">
            {data.nextUp.map((entry) => (
              <li key={entry.sessionId}>
                <Link
                  to={`/sessions/${encodeURIComponent(entry.sessionId)}`}
                  className="flex items-baseline justify-between gap-4 rounded-dusk-code px-2 py-1.5 transition-colors hover:bg-dusk-pill"
                >
                  <span className="truncate text-dusk-ink">
                    {entry.title ?? "Untitled session"}
                  </span>
                  <span className="shrink-0 text-xs text-dusk-muted">{entry.reason}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {data.checkedCount === 0 ? (
        <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
          <p className="text-xs uppercase tracking-widest text-dusk-muted">Learn</p>
          <p className="mt-2 text-sm leading-6 text-dusk-muted">
            No checks yet — the picture collects here once checks land. Start above.
          </p>
        </div>
      ) : (
        <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
          <p className="text-xs uppercase tracking-widest text-dusk-muted">Calibration picture</p>
          <p className="mt-2 text-sm leading-6 text-dusk-ink">
            {data.checkedCount} checked · {data.skippedCount} skipped · {data.notCheckedCount} not
            checked · {totalCards} cards pictured
          </p>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            {BUCKET_ORDER.map((bucket) => (
              <div key={bucket} className="flex items-baseline justify-between gap-4 text-sm">
                <dt className="text-dusk-muted">{BUCKET_LABELS[bucket]}</dt>
                <dd className="font-semibold tabular-nums text-dusk-ink">
                  {data.bucketTotals[bucket as keyof typeof data.bucketTotals] ?? 0}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {data.weakAreas.length > 0 ? (
        <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
          <p className="text-xs uppercase tracking-widest text-dusk-muted">Weakest areas</p>
          <ul className="mt-3 space-y-2 text-sm">
            {data.weakAreas.map((area) => (
              <li key={area.file} className="flex items-baseline justify-between gap-4">
                <span className="break-all font-mono text-xs text-dusk-ink">{area.file}</span>
                <span className="shrink-0 text-xs tabular-nums text-dusk-muted">
                  {area.confidentWrong} confident-but-wrong / {area.total}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className="space-y-3">
        <h2 className="text-xl font-semibold tracking-tight">Sessions</h2>
        <div className="grid gap-5 sm:grid-cols-2">
          {data.sessions.map((session) => (
            <Link
              key={session.sessionId}
              to={`/sessions/${encodeURIComponent(session.sessionId)}`}
              className="rounded-[20px] border border-transparent bg-dusk-surface px-6 py-5 transition-colors hover:border-dusk-hairline-strong"
            >
              <p className="line-clamp-3 min-h-[3rem] text-sm leading-6 text-pretty break-words text-dusk-ink">
                {session.title ??
                  (session.summary
                    ? capStorySummary(compactSessionSummary(session.summary) ?? session.summary)
                    : null) ??
                  "Untitled session"}
              </p>
              <div className="mt-4 flex items-center justify-between gap-4 border-t border-dusk-hairline pt-3.5 text-xs text-dusk-muted">
                <span>
                  {session.checkStatus === "checked"
                    ? "Checked"
                    : session.checkStatus === "skipped"
                      ? "Skipped"
                      : "Not checked"}
                </span>
                <span className="tabular-nums">
                  {session.picture.length > 0
                    ? session.picture
                        .map((entry) => BUCKET_LABELS[entry.bucket] ?? entry.bucket)
                        .slice(0, 2)
                        .join(" · ") + (session.picture.length > 2 ? "…" : "")
                    : "No picture yet"}
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
