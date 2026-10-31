import { NavLink, Outlet, useLocation } from "react-router";
import { DemoBanner } from "./components/demo-banner";
import { HeaderSearch } from "./components/search/expandable-search";
import { ProjectSort } from "./components/search/project-sort";
import { SettingsMenu } from "./components/settings/settings-sheet";
import { useDemoMode } from "./hooks/use-demo-mode";

function useSearchablePage(): boolean {
  const { pathname } = useLocation();
  if (pathname === "/" || pathname === "/projects") return true;
  return pathname.endsWith("/overview");
}

export function AppLayout() {
  const searchable = useSearchablePage();
  const { isDemo } = useDemoMode();
  return (
    <div className="flex min-h-screen flex-col">
      {isDemo ? <DemoBanner /> : null}
      <header className="mt-5">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-6">
          <NavLink to="/" className="flex items-center">
            <span className="text-lg font-semibold tracking-tight">Echo</span>
          </NavLink>
          <div className="flex items-center gap-3">
            {searchable ? <HeaderSearch /> : null}
            <ProjectSort />
            <SettingsMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-10">
        <Outlet />
      </main>
    </div>
  );
}
