import { Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { KeyboardEvent } from "react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { api } from "../../api";

type MotionPref = "full" | "reduced";
type DaemonState = "ready" | "degraded" | "offline";
type OpenReason = "first" | "last" | "pointer" | null;

interface HealthResponse {
  status: string;
  version: string;
  mode: string;
  uptimeMs: number;
}

interface RepoRow {
  id: string;
  name: string;
}

const MOTION_KEY = "echo-motion";
const COMPACT_QUERY = "(max-width: 639px)";
const PANEL_WIDTH = 340;

function subscribeCompact(change: () => void): () => void {
  const query = window.matchMedia(COMPACT_QUERY);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}

function readMotionPref(): MotionPref {
  try {
    const stored = window.localStorage.getItem(MOTION_KEY);
    if (stored === "full" || stored === "reduced") return stored;
  } catch {
    // Private mode or blocked storage: fall through to the media query.
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduced" : "full";
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function getStops(root: HTMLElement | null): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>("[data-stop]") ?? []);
}

function focusStop(stop: HTMLElement | undefined): void {
  if (!stop) return;
  if (stop.dataset.stop === "group") {
    const target =
      stop.querySelector<HTMLElement>('[aria-checked="true"]') ??
      stop.querySelector<HTMLElement>("button");
    target?.focus({ preventScroll: true });
    return;
  }
  stop.focus({ preventScroll: true });
}

function dotStyle(state: DaemonState): { background: string; border: string } {
  switch (state) {
    case "ready":
      return { background: "#6fd99a", border: "1px solid transparent" };
    case "degraded":
      return { background: "#ffb38a", border: "1px solid transparent" };
    case "offline":
      return { background: "transparent", border: "1px solid #8a8ab0" };
  }
}

export function SettingsMenu() {
  const id = useId();
  const menuId = `${id}-settings-menu`;
  const triggerId = `${id}-settings-trigger`;
  const navigate = useNavigate();
  const compact = useSyncExternalStore(
    subscribeCompact,
    () => window.matchMedia(COMPACT_QUERY).matches,
  );
  const [open, setOpen] = useState(false);
  const [motion, setMotion] = useState<MotionPref>("full");
  const [motionReady, setMotionReady] = useState(false);
  const [repos, setRepos] = useState<RepoRow[] | null>(null);
  const [reposFailed, setReposFailed] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthOk, setHealthOk] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const reason = useRef<OpenReason>(null);
  const copyTimer = useRef(0);
  const leaveTimer = useRef(0);

  // Local UI pref only: read once, never touches the daemon or config file.
  useEffect(() => {
    setMotion(readMotionPref());
    setMotionReady(true);
  }, []);

  useEffect(() => {
    if (!motionReady) return;
    document.documentElement.dataset.echoMotion = motion;
    try {
      window.localStorage.setItem(MOTION_KEY, motion);
    } catch {
      // Best-effort persistence; the in-memory choice still applies.
    }
  }, [motion, motionReady]);

  useEffect(
    () => () => {
      window.clearTimeout(copyTimer.current);
      window.clearTimeout(leaveTimer.current);
    },
    [],
  );

  const reducedMotion = motionReady && motion === "reduced";

  const setOpenState = useCallback((next: boolean, why: OpenReason = null): void => {
    window.clearTimeout(leaveTimer.current);
    setLeaving(false);
    reason.current = next ? why : null;
    if (!next) setCopied(null);
    setOpen(next);
  }, []);

  const finishClose = useCallback((returnFocus: boolean, after?: () => void): void => {
    window.clearTimeout(leaveTimer.current);
    setLeaving(false);
    reason.current = null;
    setCopied(null);
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
    after?.();
  }, []);

  // Dismissals play the leave animation, then unmount. Instant when the
  // user prefers reduced motion; a second close while leaving skips ahead.
  const requestClose = useCallback(
    (returnFocus: boolean, after?: () => void): void => {
      if (!open) {
        after?.();
        return;
      }
      if (leaving) {
        finishClose(returnFocus, after);
        return;
      }
      const instant =
        reducedMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (instant) {
        finishClose(returnFocus, after);
        return;
      }
      setLeaving(true);
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = window.setTimeout(() => finishClose(returnFocus, after), 140);
    },
    [open, leaving, reducedMotion, finishClose],
  );

  // Fetch display data lazily on open; the panel is read-only.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setReposFailed(false);
    void api
      .projects()
      .then((projects) => {
        if (!live) return;
        setRepos(projects.map((p) => ({ id: p.id, name: p.name ?? p.root })));
      })
      .catch(() => {
        if (live) setReposFailed(true);
      });
    void fetch("/api/health")
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText);
        return res.json() as Promise<HealthResponse>;
      })
      .then((payload) => {
        if (!live) return;
        setHealth(payload);
        setHealthOk(true);
      })
      .catch(() => {
        if (live) setHealthOk(false);
      });
    return () => {
      live = false;
    };
  }, [open]);

  // Focus moves in only on user intent, so a default-open menu never steals focus.
  useEffect(() => {
    if (!open) return;
    const why = reason.current;
    reason.current = null;
    if (!why) return;
    const frame = requestAnimationFrame(() => {
      const stops = getStops(surfaceRef.current);
      if (why === "first") focusStop(stops[0]);
      else if (why === "last") focusStop(stops.at(-1));
      else surfaceRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Desktop panel anchors under the trigger and flips above when crowded.
  // biome-ignore lint/correctness/useExhaustiveDependencies: repos/health are read for height — re-anchor when async content changes panel size.
  useLayoutEffect(() => {
    if (!open || compact) return;
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
      panel.style.transformOrigin = top < rect.top ? "100% 100%" : "100% 0%";
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, compact, repos, health]);

  // Outside presses close the floating panel; the sheet has its own scrim.
  useEffect(() => {
    if (!open || compact) return;
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (surfaceRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      requestClose(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, compact, requestClose]);

  // The page behind the sheet stays put.
  useEffect(() => {
    if (!open || !compact) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = previous;
    };
  }, [open, compact]);

  function changeMotion(value: MotionPref): void {
    setMotion(value);
  }

  async function handleCopy(kind: "enable" | "support"): Promise<void> {
    const text =
      kind === "enable"
        ? "echo-cli enable <path>"
        : `Echo ${health?.version ?? "0.1.0"} (${health?.mode ?? "local"}) · ${repos?.length ?? 0} repos · daemon ${healthOk ? "ok" : "unreachable"}`;
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(kind);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1500);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const stops = getStops(surfaceRef.current);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = active?.closest<HTMLElement>("[data-stop]") ?? null;
    const index = current ? stops.indexOf(current) : -1;
    const step = (to: HTMLElement | undefined) => {
      event.preventDefault();
      focusStop(to);
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
      case "ArrowLeft":
      case "ArrowRight": {
        if (current?.dataset.stop !== "group") return;
        event.preventDefault();
        const options = Array.from(
          current.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
        );
        const at = Math.max(
          0,
          options.findIndex((option) => option.getAttribute("aria-checked") === "true"),
        );
        const next =
          options[(at + (event.key === "ArrowRight" ? 1 : -1) + options.length) % options.length];
        next?.focus({ preventScroll: true });
        next?.click();
        return;
      }
      default:
        return;
    }
  }

  const daemonState: DaemonState = !healthOk
    ? "offline"
    : health?.mode === "demo"
      ? "degraded"
      : "ready";
  const daemonLabel =
    daemonState === "ready"
      ? "Daemon running"
      : daemonState === "degraded"
        ? "Demo mode"
        : "Daemon unreachable";
  const dot = dotStyle(daemonState);
  const reduced = reducedMotion;

  const content = (
    <>
      <div className="flex items-center gap-3 px-3 py-2.5">
        <span
          aria-hidden="true"
          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: dot.background, border: dot.border }}
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-dusk-ink">Echo local</p>
          <p className="truncate font-mono text-[11px] tracking-wide text-dusk-muted">
            {daemonLabel}
            {health ? ` · v${health.version}` : ""}
            {repos !== null ? ` · ${repos.length} repos` : ""}
          </p>
        </div>
      </div>
      <div className="px-2 pb-2">
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-stop="item"
          data-label="Repositories"
          className="echo-settings-row flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-white/[0.07] focus-visible:bg-white/[0.07] focus-visible:outline-none"
          onClick={() => {
            requestClose(false, () => void navigate("/projects"));
          }}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-dusk-ink">Captured repositories</span>
            <span className="block truncate font-mono text-[11px] text-dusk-muted">
              {reposFailed
                ? "Could not load — is the daemon running?"
                : repos === null
                  ? "Loading…"
                  : repos.length === 0
                    ? "None enabled yet"
                    : repos
                        .slice(0, 2)
                        .map((r) => r.name)
                        .join(" · ") + (repos.length > 2 ? ` · +${repos.length - 2}` : "")}
            </span>
          </span>
          <span aria-hidden="true" className="font-mono text-[11px] text-dusk-faint">
            →
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-stop="item"
          data-label="Copy enable command"
          className="echo-settings-row flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-white/[0.07] focus-visible:bg-white/[0.07] focus-visible:outline-none"
          onClick={() => void handleCopy("enable")}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-dusk-ink">
              {copied === "enable" ? "Copied" : "Copy enable command"}
            </span>
            <span className="block truncate font-mono text-[11px] text-dusk-muted">
              echo-cli enable &lt;path&gt;
            </span>
          </span>
        </button>
        <fieldset data-stop="group" data-label="Motion" className="m-0 border-0 p-0 px-3 py-2.5">
          <legend className="float-left w-full pb-2 text-[11px] uppercase tracking-[0.14em] text-dusk-muted">
            Motion
          </legend>
          <div className="grid w-full grid-cols-2 gap-1 rounded-full border border-dusk-hairline bg-dusk-track p-1">
            {(["full", "reduced"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                tabIndex={-1}
                aria-checked={motion === value}
                aria-label={value === "full" ? "Full motion" : "Reduced motion"}
                onClick={() => changeMotion(value)}
                className={
                  motion === value
                    ? "rounded-full bg-dusk-accent px-3 py-1.5 text-[13px] font-semibold text-dusk-base transition-colors"
                    : "rounded-full px-3 py-1.5 text-[13px] text-dusk-muted transition-colors hover:text-dusk-ink"
                }
              >
                {value === "full" ? "Full" : "Reduced"}
              </button>
            ))}
          </div>
        </fieldset>
        <div aria-hidden="true" className="mx-3 my-1 border-t border-dusk-hairline" />
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-stop="item"
          data-label="Copy support info"
          className="echo-settings-row flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-white/[0.07] focus-visible:bg-white/[0.07] focus-visible:outline-none"
          onClick={() => void handleCopy("support")}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-dusk-ink">
              {copied === "support" ? "Copied" : "Copy support info"}
            </span>
            <span className="block truncate font-mono text-[11px] text-dusk-muted">
              Version, mode, repo count — no secrets
            </span>
          </span>
        </button>
      </div>
    </>
  );

  const panel = (
    <div
      ref={surfaceRef}
      id={menuId}
      role="menu"
      aria-labelledby={triggerId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-motion={reduced ? "reduced" : "full"}
      data-leaving={leaving || undefined}
      className="echo-settings-panel fixed z-50 w-[min(340px,calc(100vw-24px))] rounded-dusk-card border border-dusk-hairline-strong bg-[rgba(28,28,48,0.85)] shadow-[0_20px_48px_rgba(0,0,0,0.5)] backdrop-blur-xl backdrop-saturate-150"
    >
      {content}
    </div>
  );

  const sheet = (
    <>
      <div
        aria-hidden="true"
        onClick={() => requestClose(true)}
        data-leaving={leaving || undefined}
        className="echo-settings-scrim fixed inset-0 z-50 bg-black/60"
      />
      <div
        ref={surfaceRef}
        id={menuId}
        role="menu"
        aria-labelledby={triggerId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-motion={reduced ? "reduced" : "full"}
        data-leaving={leaving || undefined}
        className="echo-settings-sheet fixed inset-x-3 bottom-3 z-50 rounded-dusk-card border border-dusk-hairline-strong bg-[rgba(28,28,48,0.92)] p-1 shadow-[0_20px_48px_rgba(0,0,0,0.5)] backdrop-blur-xl backdrop-saturate-150"
      >
        <span
          aria-hidden="true"
          className="mx-auto mt-2 block h-1 w-10 rounded-full bg-dusk-faint"
        />
        {content}
      </div>
    </>
  );

  return (
    <span className="inline-flex">
      <style>{SETTINGS_CSS}</style>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Settings"
        onClick={() => {
          if (leaving) {
            // Re-open beat: cancel the exit instead of closing twice.
            window.clearTimeout(leaveTimer.current);
            setLeaving(false);
            return;
          }
          if (open) requestClose(false);
          else setOpenState(true, "pointer");
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpenState(true, event.key === "ArrowDown" ? "first" : "last");
        }}
        className="grid h-10 w-10 cursor-pointer place-items-center rounded-full text-dusk-muted transition hover:-translate-y-px hover:text-dusk-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-dusk-accent"
      >
        <HugeiconsIcon icon={Settings01Icon} size={18} strokeWidth={1.8} />
      </button>
      {open ? createPortal(compact ? sheet : panel, document.body) : null}
    </span>
  );
}

const SETTINGS_CSS = `
.echo-settings-panel {
  animation: echo-settings-in 0.15s ease-out both;
  transform-origin: 100% 0%;
}
.echo-settings-sheet {
  animation: echo-settings-sheet-in 0.22s ease-out both;
}
.echo-settings-scrim { animation: echo-settings-fade .18s ease-out both; }
.echo-settings-panel[data-leaving="true"] { animation: echo-settings-out .12s ease-in both; }
.echo-settings-sheet[data-leaving="true"] { animation: echo-settings-sheet-out .14s ease-in both; }
.echo-settings-scrim[data-leaving="true"] { animation: echo-settings-fade-out .14s ease-in both; }
.echo-settings-row:focus-visible { outline: 2px solid #2d88ff; outline-offset: -2px; }
.echo-settings-row, .echo-settings-panel [role="menuitemradio"], .echo-settings-sheet [role="menuitemradio"] { cursor: pointer; }
@keyframes echo-settings-in {
  from { opacity: 0; transform: translateY(-4px) scale(.95); }
  to { opacity: 1; transform: none; }
}
@keyframes echo-settings-sheet-in {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: none; }
}
@keyframes echo-settings-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes echo-settings-out { to { opacity: 0; transform: translateY(-4px) scale(.95); } }
@keyframes echo-settings-sheet-out { to { opacity: 0; transform: translateY(12px); } }
@keyframes echo-settings-fade-out { to { opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .echo-settings-panel, .echo-settings-panel *, .echo-settings-sheet, .echo-settings-sheet * {
    animation: none !important;
    transition-duration: 0s !important;
  }
}
html[data-echo-motion="reduced"] .echo-settings-panel,
html[data-echo-motion="reduced"] .echo-settings-panel *,
html[data-echo-motion="reduced"] .echo-settings-sheet,
html[data-echo-motion="reduced"] .echo-settings-sheet * {
  animation: none !important;
  transition-duration: 0s !important;
}
`;
