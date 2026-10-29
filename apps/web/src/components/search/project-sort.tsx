import { useLocation, useSearchParams } from "react-router";

export type SortKey = "activity" | "name" | "sessions";

export const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "activity", label: "Last activity" },
  { value: "name", label: "Name" },
  { value: "sessions", label: "Sessions" },
];

function parseSort(raw: string | null): SortKey {
  return raw === "name" || raw === "sessions" ? raw : "activity";
}

/** Compact header sort for the projects grid. Hidden off the home page. */
export function ProjectSort() {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();

  if (location.pathname !== "/") return null;
  const sort = parseSort(searchParams.get("sort"));

  function changeSort(next: SortKey): void {
    const params = new URLSearchParams(searchParams);
    if (next === "activity") params.delete("sort");
    else params.set("sort", next);
    setSearchParams(params, { replace: true });
  }

  return (
    <label className="flex flex-none cursor-pointer items-center gap-1.5 text-[13px] text-dusk-muted transition hover:text-dusk-ink">
      <span aria-hidden="true">Sort</span>
      <select
        aria-label="Sort projects"
        value={sort}
        onChange={(event) => changeSort(event.target.value as SortKey)}
        className="cursor-pointer bg-transparent outline-none"
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
