import { NavLink, Outlet } from "react-router";

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `rounded-md px-3 py-1.5 text-sm transition-colors ${
    isActive ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-100"
  }`;
}

export function AppLayout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-800/80">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
          <NavLink to="/" className="flex items-center gap-3">
            <span className="flex size-8 items-center justify-center rounded-lg border border-amber-400/30 bg-amber-400/10 font-mono text-sm font-semibold text-amber-300">
              e
            </span>
            <span className="flex items-baseline gap-2">
              <span className="text-lg font-semibold tracking-tight">Echo</span>
              <span className="rounded-full border border-zinc-700 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
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
      <footer className="border-t border-zinc-800/80">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-6 py-4 text-xs text-zinc-600">
          <span>Replay what your coding agent did and why. Then prove you understood it.</span>
          <span>Muse Code is Meta's agent. Echo records and reviews it.</span>
        </div>
      </footer>
    </div>
  );
}
