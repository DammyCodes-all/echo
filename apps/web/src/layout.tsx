import { NavLink, Outlet } from "react-router";

export function AppLayout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header>
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-6">
          <NavLink to="/" className="flex items-center">
            <span className="text-lg font-semibold tracking-tight">Echo</span>
          </NavLink>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-10">
        <Outlet />
      </main>
    </div>
  );
}
