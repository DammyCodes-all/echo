import type { Change, ChangeCodeResponse, HeadsUpType } from "@echo/contracts";
import { ChangeCode } from "./change-code";

const HEADS_UP_LABEL: Record<HeadsUpType, string> = {
  not_asked: "Not asked",
  watch_out: "Watch out",
  unfinished: "Unfinished",
};

function CollapsedRow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="border-b border-dusk-hairline py-2.5">
      <summary className="cursor-pointer text-xs uppercase tracking-widest text-dusk-muted">
        {title}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

export type ChangeCardAskRef = { id: string; title: string };

export type ChangeCardCheckResult = { answered: number; correct: number; total: number };

type ChangeCardProps = {
  change: Change;
  /** Reader wiring: opens the Ask panel anchored to this change. */
  onAsk?: (ref: ChangeCardAskRef) => void;
  /** Reader wiring: triggers the per-change check for this change. */
  onCheck?: (change: Change) => void;
  checkBusy?: boolean;
  /** Served diff for this change; null while loading. */
  code?: ChangeCodeResponse | null;
  /** True when the diff request failed. */
  codeFailed?: boolean;
  /** Answered/correct counts for this change's checks; null when none exist. */
  checkResult?: ChangeCardCheckResult | null;
};

type CodeStats = { added: number; removed: number };

/** Quiet provenance byline: version (when regenerated), snapshot range, tape steps, diff stats. */
function ChangeMeta({ change, stats }: { change: Change; stats: CodeStats | null }) {
  const short = `${change.snapshotPair.prevOid.slice(0, 7)}..${change.snapshotPair.nextOid.slice(0, 7)}`;
  const full = `${change.snapshotPair.prevOid}..${change.snapshotPair.nextOid}`;
  const steps =
    change.createdFrom.kind === "tape_range"
      ? `steps ${change.createdFrom.startSeq}–${change.createdFrom.endSeq}`
      : null;
  return (
    <p className="mt-2 font-mono text-xs text-dusk-muted">
      {change.version > 1 ? (
        <span title="This change was recomputed after new snapshots landed">
          v{change.version} ·{" "}
        </span>
      ) : null}
      <span title={full}>{short}</span>
      {steps !== null ? <span title="Position in the session tape"> · {steps}</span> : null}
      {stats !== null ? (
        <span title="Added and removed lines in this change">
          {" "}
          · <span className="text-dusk-pass">+{stats.added}</span>{" "}
          <span className="text-dusk-fail">−{stats.removed}</span>
        </span>
      ) : null}
    </p>
  );
}

export function ChangeCard({
  change,
  onAsk,
  onCheck,
  checkBusy = false,
  code = null,
  codeFailed = false,
  checkResult = null,
}: ChangeCardProps) {
  const stats =
    code === null
      ? null
      : {
          added: code.files.reduce((sum, file) => sum + file.added, 0),
          removed: code.files.reduce((sum, file) => sum + file.removed, 0),
        };
  return (
    <article id={`change-${change.id}`} className="space-y-6">
      <div>
        <h2 className="text-3xl font-semibold text-dusk-ink">{change.title}</h2>
        <ChangeMeta change={change} stats={stats} />
        <p className="mt-2 text-dusk-body leading-7 text-dusk-muted">{change.summary}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-dusk-code border border-dusk-hairline bg-dusk-surface px-4 py-3">
          <p className="text-xs uppercase tracking-widest text-dusk-muted">Before</p>
          {change.before.map((line) => (
            <p key={line} className="mt-2 text-sm leading-6 text-dusk-muted">
              {line}
            </p>
          ))}
        </div>
        <div className="rounded-dusk-code border border-dusk-accent/40 bg-dusk-accent-wash px-4 py-3">
          <p className="text-xs uppercase tracking-widest text-dusk-accent">Now</p>
          {change.now.map((line) => (
            <p key={line} className="mt-2 text-sm leading-6 text-dusk-ink">
              {line}
            </p>
          ))}
        </div>
      </div>

      {change.howItWorks.length > 0 ? (
        <div>
          <p className="text-xs uppercase tracking-widest text-dusk-muted">How it works</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-dusk-ink">
            {change.howItWorks.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}

      <div>
        <p className="text-xs uppercase tracking-widest text-dusk-muted">Heads up</p>
        {change.headsUp.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-2">
            {change.headsUp.map((item) => (
              <li
                key={`${item.type}-${item.text}`}
                title={item.text}
                className="rounded-dusk-code bg-dusk-pill px-3 py-1.5 text-sm text-dusk-ink"
              >
                <span className="text-xs font-medium text-dusk-muted">
                  {HEADS_UP_LABEL[item.type]}
                </span>
                <span className="ml-2">{item.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-dusk-muted">Nothing to flag — straightforward change.</p>
        )}
      </div>

      <div className="border-t border-dusk-hairline">
        <CollapsedRow title="Code">
          {code !== null ? (
            <ChangeCode code={code} />
          ) : codeFailed ? (
            <p className="text-sm text-dusk-muted">
              The diff couldn&apos;t be loaded — the snapshots may be gone.
            </p>
          ) : (
            <p className="text-sm text-dusk-muted">Loading the diff…</p>
          )}
        </CollapsedRow>
        <CollapsedRow title="Moment">
          <p className="text-sm text-dusk-muted">
            The moment this change landed arrives with the pipeline slice — mocked for now.
          </p>
        </CollapsedRow>
      </div>

      <div>
        <p className="text-xs uppercase tracking-widest text-dusk-muted">
          Ask or check this change
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onAsk?.({ id: change.id, title: change.title })}
            disabled={onAsk === undefined}
            title={onAsk === undefined ? "Ask is not wired here" : "Ask about this change"}
            className="shrink-0 rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink disabled:opacity-40"
          >
            Ask about this change
          </button>
          <button
            type="button"
            onClick={() => onCheck?.(change)}
            disabled={onCheck === undefined || checkBusy}
            title={onCheck === undefined ? "Checks are not wired here" : "Check me on this change"}
            className="shrink-0 rounded-dusk-code bg-dusk-pill px-3 py-2 text-sm text-dusk-ink disabled:opacity-40"
          >
            {checkBusy ? "Checking…" : "Check me on this"}
          </button>
        </div>
        {checkResult !== null && checkResult.total > 0 ? (
          <p className="mt-2 text-sm text-dusk-muted">
            {checkResult.answered === checkResult.total
              ? `${checkResult.correct} of ${checkResult.total} checks passed`
              : `${checkResult.answered} of ${checkResult.total} checks answered`}
          </p>
        ) : null}
      </div>
    </article>
  );
}
