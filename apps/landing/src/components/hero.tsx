import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DemoVideoLink } from "./demo-links";
import { StoryCard } from "./story-card";
import { BlurFade } from "./ui/blur-fade";

export function Hero() {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative overflow-hidden">
      <div className="mx-auto max-w-6xl px-5 pt-24 sm:px-8 md:pt-28">
        <BlurFade>
          <h1
            id="hero-title"
            className="text-[clamp(3.75rem,11vw,7rem)] leading-[0.93] font-medium tracking-[-0.02em] text-dusk-ink"
          >
            Know what
            <br />
            <span className="text-dusk-accent">shipped</span>.
          </h1>
        </BlurFade>

        <div className="mt-8 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <BlurFade delay={0.08}>
            <p className="max-w-[52ch] text-[17px] leading-relaxed text-dusk-muted">
              Echo records your coding-agent session and turns the tape into a one-minute story —
              what shipped, what drifted from what you asked, what could bite — then checks that you
              actually understood the risky parts.
            </p>
          </BlurFade>
          <BlurFade delay={0.16}>
            <div className="flex flex-wrap items-center gap-3 md:flex-nowrap md:gap-4">
              <DemoVideoLink />
              <a
                href="https://github.com/DammyCodes-all/echo"
                className="inline-flex items-center gap-1.5 rounded-dusk-pill whitespace-nowrap px-3 py-2.5 text-[15px] font-semibold text-dusk-muted transition-colors duration-150 hover:text-dusk-ink"
              >
                View source
                <HugeiconsIcon
                  icon={ArrowUpRight01Icon}
                  size={15}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              </a>
            </div>
          </BlurFade>
        </div>
        <BlurFade delay={0.2}>
          <p className="mt-5 font-mono text-[10.5px] tracking-[0.04em] text-dusk-muted/80">
            built oct 27 – nov 4, 2026 · meta global ai developer hackathon · solo, indie track
          </p>
        </BlurFade>
      </div>

      {/* The artifact, stretched wide — the hero is the product, rendered large. */}
      <div className="mx-auto max-w-6xl px-5 pt-10 pb-16 sm:px-8 md:pt-12 lg:pb-20">
        <BlurFade delay={0.22} offset={28}>
          <StoryCard />
        </BlurFade>
      </div>
    </section>
  );
}
