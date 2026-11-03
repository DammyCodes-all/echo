import { EchoMark } from "./echo-mark";

export function SiteFooter() {
  return (
    <footer className="border-t border-dusk-hairline">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-5 px-5 py-8 sm:flex-row sm:px-8">
        <a href="#top" className="flex items-center gap-2" aria-label="Echo — back to top">
          <EchoMark className="h-5 w-5" />
          <span className="text-[15px] font-semibold text-dusk-ink">Echo</span>
        </a>
        <p className="text-center text-[13px] text-dusk-muted">
          Explains only what it can point to. Checks only calibration.
        </p>
        <nav
          aria-label="Elsewhere"
          className="flex items-center gap-5 font-mono text-[12px] text-dusk-muted"
        >
          <a
            href="https://github.com/DammyCodes-all/echo"
            className="transition-colors hover:text-dusk-ink"
          >
            GitHub
          </a>
          <a
            href="https://github.com/DammyCodes-all/echo/blob/main/docs/echo-spec.md"
            className="transition-colors hover:text-dusk-ink"
          >
            Spec
          </a>
          <a
            href="https://github.com/DammyCodes-all/echo/blob/main/LICENSE"
            className="transition-colors hover:text-dusk-ink"
          >
            License
          </a>
        </nav>
      </div>
    </footer>
  );
}
