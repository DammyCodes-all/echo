import { cn } from "../lib/utils";
import { CaptureFlow } from "./capture-flow";
import { BlurFade } from "./ui/blur-fade";

const BEATS = [
  {
    word: "Record",
    node: "solid" as const,
    body: "An ordinary Muse Code session — native logs, lifecycle hooks, shadow-Git snapshots around the tools that touch files. Secrets are scrubbed before Echo stores anything. What it can’t see becomes a labeled gap, never a fabricated record.",
  },
  {
    word: "Story",
    node: "solid" as const,
    body: "One story per session, read in a minute: what you asked, what shipped, where they diverged — behaviour changes ranked by blast radius against the chance your mental model is wrong. Verification is computed from the tape, never asserted.",
  },
  {
    word: "Check",
    node: "solid" as const,
    body: "Three to five questions aimed at the risky changes you never opened. Confidence locked before the reveal, evidence after. A picture of calibration — never a score, never a gate.",
  },
] as const;

function TapeNode({ dashed = false }: { dashed?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-1.5 block h-3.5 w-3.5 rounded-full border-2",
        dashed ? "border-dashed border-dusk-deadend bg-dusk-base" : "border-dusk-base bg-dusk-ink",
      )}
    />
  );
}

export function Loop() {
  return (
    <section id="loop" aria-labelledby="loop-title" className="border-t border-dusk-hairline">
      <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 lg:py-24">
        <h2
          id="loop-title"
          className="text-[clamp(2.5rem,6vw,4rem)] leading-[1.0] font-medium tracking-[-0.02em] text-dusk-ink"
        >
          The loop.
        </h2>

        {/* One continuous tape: the rail threads every moment on this page. */}
        <ol className="relative mt-10 lg:mt-14">
          <span
            aria-hidden="true"
            className="absolute top-2 bottom-2 left-[6px] w-px bg-dusk-rail"
          />

          {BEATS.map((beat) => (
            <li
              key={beat.word}
              className="relative grid grid-cols-[14px_1fr] gap-6 border-t border-dusk-hairline py-8 first:border-t-0 md:grid-cols-[14px_160px_1fr] md:gap-10 md:py-10"
            >
              <TapeNode />
              <h3 className="text-[24px] leading-none font-semibold tracking-[-0.01em] text-dusk-ink md:text-[28px]">
                {beat.word}
              </h3>
              <div className="col-span-2 md:col-span-1">
                <p className="max-w-[64ch] text-[16px] leading-relaxed text-dusk-muted">
                  {beat.body}
                </p>
                {beat.word === "Record" && (
                  <div className="mt-6">
                    <CaptureFlow />
                  </div>
                )}
              </div>
            </li>
          ))}

          {/* The refusal rides the same tape, as a dead-end-styled moment. */}
          <li className="relative grid grid-cols-[14px_1fr] gap-6 border-t border-dusk-hairline py-8 md:grid-cols-[14px_160px_1fr] md:gap-10 md:py-10">
            <TapeNode dashed />
            <h3 className="text-[24px] leading-none font-semibold tracking-[-0.01em] text-dusk-deadend md:text-[28px]">
              Refusal
            </h3>
            <div className="col-span-2 md:col-span-1">
              <div className="max-w-3xl rounded-dusk-uncertainty border-[1.5px] border-dashed border-dusk-faint bg-dusk-surface px-6 py-6 md:px-8">
                <p className="font-mono text-[11px] tracking-[0.08em] text-dusk-muted">
                  ask · why <span className="text-dusk-accent-soft">→</span> “and the database
                  migration?”
                </p>
                <p className="mt-3 max-w-[34ch] text-[clamp(1.35rem,2.4vw,1.9rem)] leading-snug font-medium tracking-[-0.01em] text-dusk-ink [text-wrap:balance]">
                  “I could not find evidence for that, so I will not guess.”
                </p>
                <p className="mt-3 max-w-[58ch] text-[13px] leading-relaxed text-dusk-muted">
                  Every answer is cited to a moment in the session. When the tape has nothing to
                  point to, Echo says exactly that. The refusal is the trust model — not an error
                  state.
                </p>
              </div>
            </div>
          </li>
        </ol>

        <BlurFade inView>
          <p className="mt-10 max-w-[88ch] border-t border-dusk-hairline pt-6 font-mono text-[10.5px] leading-relaxed text-dusk-muted/80">
            evidence, not vibes — +19% slower with ai (metr) · 46% distrust (so 2025) · 4/5 insecure
            (perry et al., ccs 2023) · none of these measure echo — they measure the gap it is built
            for
          </p>
        </BlurFade>
      </div>
    </section>
  );
}
