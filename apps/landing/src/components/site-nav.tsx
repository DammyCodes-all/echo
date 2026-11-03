import { GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { EchoMark } from "./echo-mark";

export function SiteNav() {
  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-dusk-hairline bg-dusk-base/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5 sm:px-8">
        <a href="#top" className="flex items-center gap-2.5" aria-label="Echo — home">
          <EchoMark className="h-7 w-7" />
          <span className="text-[19px] font-semibold tracking-[-0.01em] text-dusk-ink">Echo</span>
        </a>
        <nav
          aria-label="Sections"
          className="hidden items-center gap-7 text-[13.5px] text-dusk-muted md:flex"
        >
          <a href="#loop" className="transition-colors hover:text-dusk-ink">
            The loop
          </a>
        </nav>
        <a
          href="https://github.com/DammyCodes-all/echo"
          className="inline-flex items-center gap-2 rounded-dusk-pill border border-dusk-hairline-strong bg-dusk-secondary px-4 py-2 text-[13px] font-semibold text-dusk-accent-soft transition-[border-color,transform] duration-150 ease-out hover:border-dusk-accent active:scale-[0.97]"
        >
          <HugeiconsIcon icon={GithubIcon} size={15} strokeWidth={1.8} aria-hidden="true" />
          <span>GitHub</span>
        </a>
      </div>
    </header>
  );
}
