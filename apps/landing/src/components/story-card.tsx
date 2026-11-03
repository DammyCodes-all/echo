import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { AccentBeam } from "./ui/accent-beam";

type Panel = "diff" | "why" | "check";
type Confidence = "Guessing" | "Think so" | "Certain";

const ACTIONS: Array<{ id: Panel; label: string; primary?: boolean }> = [
  { id: "diff", label: "Show the code" },
  { id: "why", label: "Ask why" },
  { id: "check", label: "Check me", primary: true },
];

const chip =
  "rounded-dusk-pill bg-dusk-pill px-2 py-0.5 font-mono text-[11px] text-dusk-accent-soft";

export function StoryCard() {
  const [panel, setPanel] = useState<Panel>("diff");
  const [confidence, setConfidence] = useState<Confidence | null>(null);

  return (
    <figure
      className="relative overflow-hidden rounded-dusk-card border border-dusk-hairline-strong bg-dusk-surface shadow-[0_30px_90px_rgba(0,0,0,0.5)]"
      aria-label="Illustrative Echo behaviour card, synthetic session"
    >
      <AccentBeam />

      <div className="grid lg:grid-cols-[1.15fr_1fr]">
        {/* Behaviour half */}
        <div className="flex flex-col gap-3 border-b border-dusk-hairline px-5 pt-5 pb-5 sm:px-6 lg:border-r lg:border-b-0">
          <div className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-2 font-mono text-[12px] text-dusk-muted">
              <span className="inline-block h-2 w-2 rounded-full bg-dusk-pass" aria-hidden="true" />
              payments-api
            </span>
            <span className="font-mono text-[10px] text-dusk-muted">
              session 218 · finalized 14:02
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-dusk-pill bg-dusk-pass-wash px-2.5 py-1 font-mono text-[11px] text-dusk-pass">
              <span className="h-1.5 w-1.5 rounded-full bg-dusk-pass" aria-hidden="true" />
              observed
            </span>
            <code className="rounded-dusk-code border border-dusk-hairline bg-dusk-pill px-2 py-1 font-mono text-[11px] text-dusk-ink">
              webhook.ts <span className="text-dusk-pass">+38</span>{" "}
              <span className="text-dusk-fail">−4</span>
            </code>
          </div>

          <p className="text-[clamp(1.35rem,2.2vw,1.75rem)] leading-snug font-semibold tracking-[-0.01em] text-dusk-ink">
            Webhook retries now back off exponentially, capped at 3 attempts.
          </p>

          <p className="text-[13px] leading-snug text-dusk-muted">
            Touches payment delivery · nothing observed the cap · your ask said{" "}
            <span className="text-dusk-ink">“retry until it works.”</span>
          </p>

          <div className="flex flex-wrap gap-1.5">
            <span className={chip}>turn 14</span>
            <span className={chip}>turn 15</span>
            <span className="rounded-dusk-pill border border-dusk-hairline px-2 py-0.5 font-mono text-[11px] text-dusk-muted">
              shadow snapshot · final
            </span>
            <span className="rounded-dusk-pill bg-dusk-pill px-2 py-0.5 font-mono text-[10px] text-dusk-accent-soft">
              agent-stated
            </span>
          </div>

          <p className="mt-auto pt-2 text-[13px] leading-snug text-dusk-muted">
            Mirrors the backoff in{" "}
            <code className="font-mono text-[12px] text-dusk-ink">cron.ts</code>; the cap matches
            the processor’s retry window.
          </p>
        </div>

        {/* Interaction half */}
        <div className="flex flex-col">
          <fieldset
            aria-label="Card actions"
            className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 border-b border-dusk-hairline p-0 px-5 py-3.5 sm:px-6"
          >
            {ACTIONS.map(({ id, label, primary }) => (
              <button
                key={id}
                type="button"
                aria-pressed={panel === id}
                onClick={() => setPanel(id)}
                className={cn(
                  "rounded-dusk-pill px-3.5 py-1.5 text-[13px] font-semibold transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.97]",
                  panel === id
                    ? primary
                      ? "bg-dusk-accent text-dusk-base"
                      : "bg-dusk-secondary text-dusk-accent-soft"
                    : "text-dusk-muted hover:text-dusk-ink",
                )}
              >
                {label}
              </button>
            ))}
          </fieldset>

          <div className="flex-1 px-5 py-4 sm:px-6">
            {panel === "diff" && (
              <div>
                <pre className="overflow-x-auto rounded-dusk-code border border-dusk-hairline bg-dusk-base p-3 font-mono text-[12px] leading-relaxed">
                  <code>
                    <span className="ln-del block">- retry: {"{ forever: true }"}</span>
                    <span className="ln-add block">+ retry: {"{ attempts: 3,"}</span>
                    <span className="ln-add block">{`+   backoff: "exponential",`}</span>
                    <span className="ln-add block">{"+   capMs: 30_000 }"}</span>
                  </code>
                </pre>
                <p className="mt-2 text-[11.5px] text-dusk-muted">
                  Before and now, inline — from the shadow snapshot, not the agent’s word.
                </p>
              </div>
            )}

            {panel === "why" && (
              <div className="rounded-dusk-code border border-dusk-hairline bg-dusk-base p-4">
                <p className="text-[13px] font-semibold text-dusk-ink">Why the 3-attempt cap?</p>
                <p className="mt-1.5 text-[13px] leading-snug text-dusk-muted">
                  Turn 15 logs the processor rejecting delivery after three attempts. The cap
                  matches that window instead of retrying into a dead end.{" "}
                  <span className="ml-1 rounded-dusk-pill bg-dusk-pill px-1.5 py-0.5 font-mono text-[10px] text-dusk-accent-soft">
                    turn 15
                  </span>
                </p>
              </div>
            )}

            {panel === "check" && (
              <div className="rounded-dusk-code border border-dusk-hairline bg-dusk-base p-4">
                <p className="text-[13px] font-semibold text-dusk-ink">
                  Why is the cap 3 and not, say, 8?
                </p>
                <p className="mt-1 font-mono text-[10px] tracking-[0.12em] text-dusk-muted uppercase">
                  Lock your confidence first
                </p>
                <fieldset
                  aria-label="Confidence"
                  className="m-0 mt-2 flex min-w-0 flex-wrap gap-1.5 border-0 p-0"
                >
                  {(["Guessing", "Think so", "Certain"] as const).map((level) => (
                    <button
                      key={level}
                      type="button"
                      aria-pressed={confidence === level}
                      onClick={() => setConfidence(level)}
                      className={cn(
                        "rounded-dusk-pill border px-2.5 py-1 text-[12px] font-medium transition-[background-color,border-color,color,transform] duration-150 ease-out active:scale-[0.97]",
                        confidence === level
                          ? "border-dusk-accent bg-dusk-accent text-dusk-base"
                          : "border-dusk-hairline-strong text-dusk-muted hover:border-dusk-accent hover:text-dusk-ink",
                      )}
                    >
                      {level}
                    </button>
                  ))}
                </fieldset>
                {confidence !== null && (
                  <p className="mt-2 border-t border-dusk-hairline pt-2 text-[13px] leading-snug text-dusk-muted">
                    <span className="text-dusk-ink">
                      Because the processor stops accepting retries after the third.
                    </span>{" "}
                    Turn 15 shows it dropping the delivery; anything past 3 is silently discarded.{" "}
                    <span className="rounded-dusk-pill bg-dusk-pill px-1.5 py-0.5 font-mono text-[10px] text-dusk-accent-soft">
                      turn 15
                    </span>
                  </p>
                )}
              </div>
            )}
          </div>

          <figcaption className="flex items-center justify-between border-t border-dusk-hairline px-5 py-2.5 sm:px-6">
            <span className="font-mono text-[9.5px] text-dusk-muted">
              synthetic session · the product, not a mockup
            </span>
            <span className="flex items-center gap-1 font-mono text-[9.5px] text-dusk-muted">
              story
              <HugeiconsIcon
                icon={ArrowUpRight01Icon}
                size={10}
                strokeWidth={2}
                aria-hidden="true"
              />
            </span>
          </figcaption>
        </div>
      </div>
    </figure>
  );
}
