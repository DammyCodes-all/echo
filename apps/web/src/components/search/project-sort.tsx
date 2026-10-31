import { ChevronDownIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useSearchParams } from "react-router";

export type SortKey = "activity" | "name" | "sessions";

export const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: "activity", label: "Last activity" },
  { value: "name", label: "Name" },
  { value: "sessions", label: "Sessions" },
];

type OpenReason = "first" | "last" | "pointer" | null;

const PANEL_WIDTH = 200;

function parseSort(raw: string | null): SortKey {
  return raw === "name" || raw === "sessions" ? raw : "activity";
}

function getStops(root: HTMLElement | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>("[data-stop]") ?? []);
}

/**
 * Header sort dropdown for the projects grid, in the style of the settings
 * menu (glass panel, popover open/close motion, full keyboard support).
 * Writes `?sort=` (`activity` default omits the param). Hidden off-home.
 */
export function ProjectSort() {
  const id = useId();
  const menuId = `${id}-sort-menu`;
  const triggerId = `${id}-sort-trigger`;
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [motionReduced, setMotionReduced] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const reason = useRef<OpenReason>(null);
  const leaveTimer = useRef(0);

  useEffect(() => {
    setMotionReduced(
      document.documentElement.dataset.echoMotion === "reduced" ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
  }, []);

  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  const finishClose = useCallback((returnFocus: boolean): void => {
    window.clearTimeout(leaveTimer.current);
    setLeaving(false);
    reason.current = null;
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);

  const requestClose = useCallback(
    (returnFocus: boolean): void => {
      if (!open) return;
      if (leaving) {
        finishClose(returnFocus);
        return;
      }
      if (motionReduced) {
        finishClose(returnFocus);
        return;
      }
      setLeaving(true);
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = window.setTimeout(() => finishClose(returnFocus), 140);
    },
    [open, leaving, motionReduced, finishClose],
  );

  // Focus moves in only on user intent, so a default-open menu never steals it.
  useEffect(() => {
    if (!open) return;
    const why = reason.current;
    reason.current = null;
    if (!why) return;
    const frame = requestAnimationFrame(() => {
      const stops = getStops(surfaceRef.current);
      if (why === "first") stops[0]?.focus({ preventScroll: true });
      else if (why === "last") stops.at(-1)?.focus({ preventScroll: true });
      else surfaceRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Desktop panel anchors under the trigger, flipping above when crowded.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = surfaceRef.current;
    const trigger = triggerRef.current;
    if (!panel || !trigger) return;
    const place = () => {
      const rect = trigger.getBoundingClientRect();
      const height = panel.offsetHeight;
      const wanted = rect.right - PANEL_WIDTH;
      const left = Math.min(Math.max(12, wanted), window.innerWidth - PANEL_WIDTH - 12);
      const below = rect.bottom + 8;
      const top =
        below + height > window.innerHeight - 12 && rect.top - 8 - height > 12
          ? rect.top - 8 - height
          : below;
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // Outside presses close the panel.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (surfaceRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      requestClose(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, requestClose]);

  if (location.pathname !== "/") return null;
  const sort = parseSort(searchParams.get("sort"));

  function changeSort(next: SortKey): void {
    const params = new URLSearchParams(searchParams);
    if (next === "activity") params.delete("sort");
    else params.set("sort", next);
    setSearchParams(params, { replace: true });
    requestClose(true);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const stops = getStops(surfaceRef.current);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = active?.closest<HTMLElement>("[data-stop]") ?? null;
    const index = current ? stops.indexOf(current) : -1;
    const step = (to: HTMLElement | undefined) => {
      event.preventDefault();
      to?.focus({ preventScroll: true });
    };
    switch (event.key) {
      case "ArrowDown":
        step(stops[(index + 1) % stops.length]);
        return;
      case "ArrowUp":
        step(stops[index <= 0 ? stops.length - 1 : index - 1]);
        return;
      case "Home":
        step(stops[0]);
        return;
      case "End":
        step(stops.at(-1));
        return;
      case "Escape":
      case "Tab":
        event.preventDefault();
        requestClose(true);
        return;
      default:
        return;
    }
  }

  const label = SORT_OPTIONS.find((option) => option.value === sort)?.label ?? "Last activity";

  return (
    <span className="inline-flex flex-none">
      <style>{SORT_CSS}</style>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Sort projects, current: ${label}`}
        onClick={() => {
          if (leaving) {
            window.clearTimeout(leaveTimer.current);
            setLeaving(false);
            return;
          }
          if (open) requestClose(false);
          else {
            reason.current = "pointer";
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          reason.current = event.key === "ArrowDown" ? "first" : "last";
          setOpen(true);
        }}
        className="flex h-10 cursor-pointer items-center gap-1 text-[13px] text-dusk-muted transition hover:text-dusk-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent"
      >
        <span aria-hidden="true">Sort</span>
        <span className="max-w-24 truncate font-medium text-dusk-ink">{label}</span>
        <HugeiconsIcon icon={ChevronDownIcon} size={15} strokeWidth={1.8} aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={surfaceRef}
              id={menuId}
              role="menu"
              aria-labelledby={triggerId}
              tabIndex={-1}
              onKeyDown={onKeyDown}
              data-leaving={leaving || undefined}
              data-motion={motionReduced ? "reduced" : "full"}
              className="es-sort-panel fixed z-50 rounded-dusk-card border border-dusk-hairline-strong bg-[rgba(28,28,48,0.85)] p-1.5 shadow-[0_20px_48px_rgba(0,0,0,0.5)] backdrop-blur-xl backdrop-saturate-150"
              style={{ width: PANEL_WIDTH }}
            >
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  tabIndex={-1}
                  data-stop="item"
                  aria-checked={option.value === sort}
                  onClick={() => changeSort(option.value)}
                  className="es-sort-row flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-dusk-ink transition-colors hover:bg-white/[0.07] focus-visible:bg-white/[0.07] focus-visible:outline-none"
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.value === sort ? (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      size={15}
                      strokeWidth={2}
                      aria-hidden="true"
                      className="flex-none text-dusk-accent"
                    />
                  ) : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}

const SORT_CSS = `
.es-sort-panel { animation: es-sort-in 0.15s ease-out both; transform-origin: 100% 0%; }
.es-sort-panel[data-leaving="true"] { animation: es-sort-out 0.12s ease-in both; }
.es-sort-row:focus-visible { outline: 2px solid #2d88ff; outline-offset: -2px; }
@keyframes es-sort-in {
  from { opacity: 0; transform: translateY(-4px) scale(.95); }
  to { opacity: 1; transform: none; }
}
@keyframes es-sort-out { to { opacity: 0; transform: translateY(-4px) scale(.95); } }
@media (prefers-reduced-motion: reduce) {
  .es-sort-panel, .es-sort-panel * { animation: none !important; transition-duration: 0s !important; }
}
html[data-echo-motion="reduced"] .es-sort-panel,
html[data-echo-motion="reduced"] .es-sort-panel * {
  animation: none !important;
  transition-duration: 0s !important;
}
`;
