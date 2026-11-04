import type { Change } from "@echo/contracts";

type CaughtUpProps = {
  summary: string;
  skipped: Change[];
  total: number;
  neverOpened: number;
  onDone: () => void;
  onRevisit: (change: Change) => void;
};

/** One plain sentence topping the end screen: totals only, no scores. */
export function endScreenSummary(total: number, skipped: number, neverOpened: number): string {
  const changes = total === 1 ? "change" : "changes";
  return `This session had ${total} ${changes}. You skipped ${skipped} and never opened ${neverOpened}.`;
}

const PRIMARY =
  "rounded-dusk-pill bg-dusk-accent px-5 py-2.5 text-sm font-semibold text-dusk-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent";

export function CaughtUp({
  summary,
  skipped,
  total,
  neverOpened,
  onDone,
  onRevisit,
}: CaughtUpProps) {
  return (
    <div className="space-y-6 rounded-dusk-card bg-dusk-surface px-6 py-8">
      <div>
        <p className="text-xs uppercase tracking-widest text-dusk-muted">Caught up</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-dusk-ink">
          That&apos;s the whole session.
        </h2>
        <p className="mt-3 text-[17px] leading-7 text-dusk-ink">
          {endScreenSummary(total, skipped.length, neverOpened)}
        </p>
        <p className="mt-2 text-sm leading-6 text-dusk-muted">{summary}</p>
      </div>

      {skipped.length > 0 ? (
        <div className="border-t border-dusk-hairline pt-4">
          <p className="text-xs uppercase tracking-widest text-dusk-muted">
            Skipped · {skipped.length}
          </p>
          <ul className="mt-1 divide-y divide-dusk-hairline">
            {skipped.map((change) => (
              <li key={change.id}>
                <button
                  type="button"
                  onClick={() => onRevisit(change)}
                  title="Jump back to this change"
                  className="block w-full py-2 text-left text-sm text-dusk-muted underline-offset-4 hover:text-dusk-ink hover:underline"
                >
                  {change.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="border-t border-dusk-hairline pt-4 text-sm text-dusk-muted">
          Nothing skipped. Every change got a nod.
        </p>
      )}

      <button type="button" onClick={onDone} className={PRIMARY}>
        Done, back to inbox
      </button>
    </div>
  );
}
