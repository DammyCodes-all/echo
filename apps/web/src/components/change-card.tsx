import type { Change, HeadsUpType } from "@echo/contracts";

const HEADS_UP_LABEL: Record<HeadsUpType, string> = {
  not_asked: "Not asked",
  watch_out: "Watch out",
  unfinished: "Unfinished",
};

function CollapsedRow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="rounded-dusk-code bg-dusk-pill px-4 py-3">
      <summary className="cursor-pointer font-mono text-xs uppercase tracking-widest text-dusk-muted">
        {title}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

export type ChangeCardAskRef = { id: string; title: string };

type ChangeCardProps = {
  change: Change;
  /** Reader wiring: opens the Ask panel anchored to this change. */
  onAsk?: (ref: ChangeCardAskRef) => void;
  /** Reader wiring: triggers the per-change check for this change. */
  onCheck?: (change: Change) => void;
  checkBusy?: boolean;
};

export function ChangeCard({ change, onAsk, onCheck, checkBusy = false }: ChangeCardProps) {
  return (
    <article id={`change-${change.id}`} className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-dusk-ink">{change.title}</h2>
        <p className="mt-2 text-dusk-body leading-6 text-dusk-ink">{change.summary}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-dusk-code bg-dusk-surface px-4 py-3">
          <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">Before</p>
          {change.before.map((line) => (
            <p key={line} className="mt-2 text-sm leading-6 text-dusk-muted">
              {line}
            </p>
          ))}
        </div>
        <div className="rounded-dusk-code border border-dusk-hairline-strong bg-dusk-peach-wash/40 px-4 py-3">
          <p className="font-mono text-xs uppercase tracking-widest text-dusk-peach">Now</p>
          {change.now.map((line) => (
            <p key={line} className="mt-2 text-sm leading-6 text-dusk-ink">
              {line}
            </p>
          ))}
        </div>
      </div>

      {change.howItWorks.length > 0 ? (
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
            How it works
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-dusk-ink">
            {change.howItWorks.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}

      <div>
        <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">Heads up</p>
        {change.headsUp.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-2">
            {change.headsUp.map((item) => (
              <li
                key={`${item.type}-${item.text}`}
                title={item.text}
                className="rounded-dusk-code bg-dusk-pill px-3 py-1.5 text-sm text-dusk-ink"
              >
                <span className="font-mono text-xs text-dusk-accent-soft">
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

      <div className="space-y-2">
        <CollapsedRow title={`Files · ${change.files.length}`}>
          <ul className="space-y-2">
            {change.files.map((file) => (
              <li key={file.path} className="text-sm">
                <span className="font-mono text-xs text-dusk-accent-soft">{file.path}</span>
                <span className="ml-2 text-dusk-muted">{file.note}</span>
              </li>
            ))}
          </ul>
        </CollapsedRow>
        <CollapsedRow title="Code">
          <p className="text-sm text-dusk-muted">
            The diff for this change arrives with the pipeline slice — mocked for now.
          </p>
        </CollapsedRow>
        <CollapsedRow title="Moment">
          <p className="text-sm text-dusk-muted">
            The moment this change landed arrives with the pipeline slice — mocked for now.
          </p>
        </CollapsedRow>
      </div>

      <div>
        <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
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
            className="shrink-0 rounded-dusk-code bg-dusk-accent px-3 py-2 text-sm font-semibold text-dusk-base disabled:opacity-40"
          >
            {checkBusy ? "Checking…" : "Check me on this"}
          </button>
        </div>
      </div>
    </article>
  );
}
