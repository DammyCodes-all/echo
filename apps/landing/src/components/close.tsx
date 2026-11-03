import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { DemoVideoLink, HostedDemoLink } from "./demo-links";

export function Close() {
  return (
    <section id="close" aria-labelledby="close-title" className="border-t border-dusk-hairline">
      <div className="mx-auto grid max-w-6xl items-end gap-12 px-5 py-16 sm:px-8 lg:grid-cols-12 lg:py-24">
        <div className="lg:col-span-8">
          <h2
            id="close-title"
            className="text-[clamp(3.5rem,10vw,6.5rem)] leading-[0.95] font-medium tracking-[-0.02em] text-dusk-ink"
          >
            Built in
            <br />
            <span className="text-dusk-accent">six days.</span>
          </h2>
          <p className="mt-7 max-w-[54ch] text-[17px] leading-relaxed text-dusk-muted">
            Echo was built Oct 27–Nov 4, 2026 for the Meta Global AI Developer Hackathon — Indie
            Developer track, Build for Your World. Muse Code and Muse Spark are Meta’s. The
            recorder, the tape format, shadow-Git capture, the deterministic trust layer and the
            calibration check are Echo’s — and they are the point.
          </p>
        </div>
        <div className="flex flex-col gap-3 lg:col-span-4">
          <DemoVideoLink className="w-full justify-center" />
          <HostedDemoLink className="w-full justify-center" />
          <p className="mt-3 text-center font-mono text-[11.5px] text-dusk-muted lg:text-left">
            <a
              className="inline-flex items-center gap-1 transition-colors hover:text-dusk-ink"
              href="https://github.com/DammyCodes-all/echo"
            >
              Source on GitHub
              <HugeiconsIcon icon={ArrowRight01Icon} size={12} strokeWidth={2} aria-hidden="true" />
            </a>
            <span className="mx-3 text-dusk-faint">·</span>
            <a
              className="inline-flex items-center gap-1 transition-colors hover:text-dusk-ink"
              href="https://github.com/DammyCodes-all/echo/blob/main/docs/echo-spec.md"
            >
              Read the spec
              <HugeiconsIcon icon={ArrowRight01Icon} size={12} strokeWidth={2} aria-hidden="true" />
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}
