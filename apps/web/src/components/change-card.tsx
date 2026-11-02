import type { Change, ChangeCodeResponse, HeadsUpType } from "@echo/contracts";
import { ChangeCode } from "./change-code";

const HEADS_UP_LABEL: Record<HeadsUpType, string> = {
  not_asked: "Not asked",
  watch_out: "Watch out",
  unfinished: "Unfinished",
};

const HEADS_UP_STYLE: Record<HeadsUpType, { dot: string; label: string }> = {
  not_asked: {
    dot: "bg-dusk-accent",
    label: "text-dusk-accent-soft",
  },
  watch_out: {
    dot: "bg-dusk-fail",
    label: "text-dusk-fail",
  },
  unfinished: {
    dot: "bg-dusk-peach",
    label: "text-dusk-peach",
  },
};

function CollapsedRow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="py-3">
      <summary className="cursor-pointer text-xs uppercase tracking-widest text-dusk-muted">
        {title}
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}

export type ChangeConnection = {
  id: string;
  title: string;
  /** Earlier built the groundwork; later revisited the same files. */
  direction: "earlier" | "later";
};

type ChangeCardProps = {
  change: Change;
  /** Served diff for this change; null while loading. */
  code?: ChangeCodeResponse | null;
  /** True when the diff request failed. */
  codeFailed?: boolean;
  /** Same-file neighbors in session order; empty when standalone. */
  connections?: ChangeConnection[];
  /** Reader wiring: jump to a connected change. */
  onJumpToChange?: (id: string) => void;
};

export function ChangeCard({
  change,
  code = null,
  codeFailed = false,
  connections = [],
  onJumpToChange,
}: ChangeCardProps) {
  return (
    <article id={`change-${change.id}`} className="space-y-6">
      <div>
        <h2 className="text-3xl font-semibold text-dusk-ink">{change.title}</h2>
        {change.moment ? (
          <p className="mt-1.5 text-sm text-dusk-muted">You asked for: {change.moment}</p>
        ) : null}
        {connections.length > 0 ? (
          <p className="mt-1 text-sm text-dusk-muted">
            {connections.map((connection, index) => (
              <span key={connection.id}>
                {index > 0 ? " · " : null}
                {connection.direction === "earlier" ? "Builds on " : "Changed again in "}
                <button
                  type="button"
                  onClick={() => onJumpToChange?.(connection.id)}
                  className="underline underline-offset-4 hover:text-dusk-ink"
                >
                  {connection.title}
                </button>
              </span>
            ))}
          </p>
        ) : null}
        {change.headsUp.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2">
            {change.headsUp.map((item) => (
              <li
                key={`${item.type}-${item.text}`}
                title={item.text}
                className="inline-flex items-center gap-2 rounded-dusk-code bg-dusk-pill px-3 py-1.5 text-sm text-dusk-ink"
              >
                <span
                  aria-hidden
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${HEADS_UP_STYLE[item.type].dot}`}
                />
                <span className={`text-xs font-semibold ${HEADS_UP_STYLE[item.type].label}`}>
                  {HEADS_UP_LABEL[item.type]}
                </span>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        ) : null}
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

      {(change.verify?.length ?? 0) > 0 ? (
        <div>
          <p className="text-xs uppercase tracking-widest text-dusk-muted">Verify</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-dusk-ink">
            {(change.verify ?? []).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}

      <div className="border-t border-dusk-hairline pt-1">
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
      </div>
    </article>
  );
}
