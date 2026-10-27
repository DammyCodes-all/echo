import { NavLink, Outlet } from "react-router";

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `rounded-dusk-pill px-3 py-1.5 text-sm transition-colors ${
    isActive ? "bg-dusk-pill text-dusk-ink" : "text-dusk-muted hover:text-dusk-ink"
  }`;
}

export function AppLayout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-dusk-hairline">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
          <NavLink to="/" className="flex items-center gap-3">
            <span className="flex size-8 items-center justify-center rounded-dusk-code border border-dusk-accent/30 bg-dusk-accent-wash font-mono text-sm font-semibold text-dusk-accent-soft">
              e
            </span>
            <span className="flex items-baseline gap-2">
              <span className="text-lg font-semibold tracking-tight">Echo</span>
              <span className="rounded-dusk-pill border border-dusk-hairline-strong px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-dusk-muted">
                scaffold
              </span>
            </span>
          </NavLink>
          <nav className="flex items-center gap-1">
            <NavLink to="/" end className={navLinkClass}>
              Projects
            </NavLink>
            <NavLink to="/demo" className={navLinkClass}>
              Demo
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-10">
        <Outlet />
      </main>
      <footer className="border-t border-dusk-hairline">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-6 py-4 text-xs text-dusk-muted">
          <span>Replay what your coding agent did and why. Then prove you understood it.</span>
          <span>Muse Code is Meta's agent. Echo records and reviews it.</span>
        </div>
      </footer>
    </div>
  );
}
