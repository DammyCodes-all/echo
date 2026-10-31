import type { Change } from "@echo/contracts";

type CaughtUpProps = {
  summary: string;
  skipped: Change[];
  onDone: () => void;
  onRevisit: (change: Change) => void;
};

const PRIMARY =
  "rounded-dusk-pill bg-dusk-accent px-5 py-2.5 text-sm font-semibold text-dusk-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent";

export function CaughtUp({ summary, skipped, onDone, onRevisit }: CaughtUpProps) {
  return (
    <div className="space-y-6 rounded-dusk-card bg-dusk-surface px-6 py-8">
      <div>
        <p className="text-xs uppercase tracking-widest text-dusk-muted">Caught up</p>
        <h2 className="mt-2 text-2xl font-semibold text-dusk-ink">
          That&apos;s the whole session.
        </h2>
        <p className="mt-2 text-dusk-body leading-6 text-dusk-ink">{summary}</p>
      </div>

      {skipped.length > 0 ? (
        <div>
          <p className="text-xs uppercase tracking-widest text-dusk-muted">
            Skipped · {skipped.length}
          </p>
          <ul className="mt-2 space-y-2">
            {skipped.map((change) => (
              <li key={change.id}>
                <button
                  type="button"
                  onClick={() => onRevisit(change)}
                  title="Jump back to this change"
                  className="text-left text-sm text-dusk-muted underline underline-offset-4 hover:text-dusk-ink"
                >
                  {change.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-dusk-muted">Nothing skipped — every change got a nod.</p>
      )}

      <button type="button" onClick={onDone} className={PRIMARY}>
        Done — back to inbox
      </button>
    </div>
  );
}
