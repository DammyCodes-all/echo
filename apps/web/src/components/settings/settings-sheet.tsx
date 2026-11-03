import type { FolderResolveResponse, HooksStatus, ProjectSummary } from "@echo/contracts";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Copy01Icon,
  Delete02Icon,
  Folder01Icon,
  FolderAddIcon,
  Plug01Icon,
  Settings01Icon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
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
import { displayProjectName } from "../../project-display";

type MotionPref = "full" | "reduced";
type DaemonState = "ready" | "degraded" | "offline";
type OpenReason = "first" | "last" | "pointer" | null;

interface HealthResponse {
  status: string;
  version: string;
  mode: string;
  uptimeMs: number;
}

interface Candidates {
  name: string;
  matches: string[];
  truncated: boolean;
}

type PickerWindow = Window & {
  showDirectoryPicker?: () => Promise<{ name: string }>;
};

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
  stop?.focus({ preventScroll: true });
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

function RepoRow({
  name,
  title,
  busy,
  disabled,
  onRemove,
  removeLabel,
}: {
  name: string;
  title: string;
  busy: boolean;
  disabled: boolean;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <div className="echo-settings-row flex w-full items-center gap-2 rounded-lg px-3 py-1.5 transition-colors hover:bg-white/[0.07]">
      <span aria-hidden className="inline-flex shrink-0 text-dusk-faint">
        <HugeiconsIcon icon={Folder01Icon} size={14} strokeWidth={1.8} />
      </span>
      <span title={title} className="min-w-0 flex-1 truncate font-mono text-xs text-dusk-ink">
        {name}
      </span>
      <button
        type="button"
        disabled={disabled || busy}
        onClick={onRemove}
        title={removeLabel}
        aria-label={removeLabel}
        className="inline-flex shrink-0 cursor-pointer items-center rounded p-1 text-dusk-muted transition-colors hover:text-dusk-fail disabled:cursor-not-allowed disabled:opacity-50"
      >
        <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={1.8} />
      </button>
    </div>
  );
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
  const [repos, setRepos] = useState<string[] | null>(null);
  const [reposFailed, setReposFailed] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [reposOpen, setReposOpen] = useState(false);
  const [reposNote, setReposNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [removePath, setRemovePath] = useState<string | null>(null);
  const [hooks, setHooks] = useState<HooksStatus | null>(null);
  const [hooksBusy, setHooksBusy] = useState(false);
  const [hooksNote, setHooksNote] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderNote, setFolderNote] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidates | null>(null);
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
    if (!next) {
      setCopied(null);
      setHooksNote(null);
      setFolderNote(null);
      setCandidates(null);
      setReposOpen(false);
      setReposNote(null);
    }
    setOpen(next);
  }, []);

  const finishClose = useCallback((returnFocus: boolean, after?: () => void): void => {
    window.clearTimeout(leaveTimer.current);
    setLeaving(false);
    reason.current = null;
    setCopied(null);
    setHooksNote(null);
    setFolderNote(null);
    setCandidates(null);
    setReposOpen(false);
    setReposNote(null);
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

  // Fetch display data lazily on open; actions refresh it in place.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setReposFailed(false);
    void api
      .settings()
      .then((payload) => {
        if (!live) return;
        setRepos(payload.projects);
        setHooks(payload.hooks);
      })
      .catch(() => {
        if (live) setReposFailed(true);
      });
    // The allowlist can hold several folders per repository, so the header
    // counts materialized projects — the same number the projects page shows.
    void api
      .projects()
      .then((listed) => {
        if (!live) return;
        setProjects(listed);
      })
      .catch(() => {
        if (live) setProjects(null);
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

  async function handleCopyEnable(): Promise<void> {
    const ok = await copyText("echo-cli enable <path>");
    if (!ok) return;
    setCopied("enable");
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1500);
  }

  function refreshSettings(): void {
    setReposFailed(false);
    void api
      .settings()
      .then((payload) => {
        setRepos(payload.projects);
        setHooks(payload.hooks);
      })
      .catch(() => setReposFailed(true));
    void api
      .projects()
      .then((listed) => setProjects(listed))
      .catch(() => setProjects(null));
  }

  async function handleInstallHooks(): Promise<void> {
    if (demo || hooksBusy) return;
    setHooksBusy(true);
    setHooksNote(null);
    try {
      const result = await api.installHooks();
      setHooksNote(
        result.changed
          ? `Turned on — following all ${result.eventsInstalled.length}.` +
              (result.backupPath ? " Your previous settings were backed up first." : "")
          : "Already on — nothing changed.",
      );
      refreshSettings();
    } catch (error) {
      setHooksNote(error instanceof Error ? error.message : "Install failed.");
    } finally {
      setHooksBusy(false);
    }
  }

  async function enablePickedPath(path: string): Promise<void> {
    try {
      const result = await api.enableProject(path);
      setCandidates(null);
      setFolderNote(`Now capturing ${result.path}.`);
      refreshSettings();
    } catch (error) {
      setFolderNote(error instanceof Error ? error.message : "Could not add that folder.");
    } finally {
      setFolderBusy(false);
    }
  }

  async function handleRemoveRepo(path: string): Promise<void> {
    if (demo || removePath !== null) return;
    setRemovePath(path);
    setReposNote(null);
    try {
      const result = await api.disableProject(path);
      const short = path.split("/").pop() ?? path;
      setReposNote({
        text: result.removed ? `Stopped capturing ${short}.` : `${short} wasn't in the list.`,
        ok: true,
      });
      refreshSettings();
    } catch (error) {
      setReposNote({
        text: error instanceof Error ? error.message : "Could not remove that folder.",
        ok: false,
      });
    } finally {
      setRemovePath(null);
    }
  }

  /** Removing a repo stops every enabled folder inside it — subfolders never surface on their own. */
  async function handleRemoveProject(project: ProjectSummary, paths: string[]): Promise<void> {
    if (demo || removePath !== null) return;
    setRemovePath(project.id);
    setReposNote(null);
    try {
      for (const path of paths) {
        await api.disableProject(path);
      }
      setReposNote({
        text: `Stopped capturing ${displayProjectName(project)}.`,
        ok: true,
      });
      refreshSettings();
    } catch (error) {
      setReposNote({
        text: error instanceof Error ? error.message : "Could not remove that repository.",
        ok: false,
      });
    } finally {
      setRemovePath(null);
    }
  }

  /** Enabled folders grouped under their repo; leftovers the daemon couldn't place. */
  function groupedRepos(): {
    groups: Array<{ project: ProjectSummary; paths: string[] }>;
    stale: string[];
  } | null {
    if (projects === null || repos === null) return null;
    const claimed = new Set<string>();
    const groups = projects.map((project) => {
      const paths = repos.filter((path) => {
        const inside = path === project.root || path.startsWith(`${project.root}/`);
        if (inside) claimed.add(path);
        return inside;
      });
      return { project, paths };
    });
    return { groups, stale: repos.filter((path) => !claimed.has(path)) };
  }

  async function handlePickFolder(): Promise<void> {
    if (demo || folderBusy) return;
    const picker = (window as PickerWindow).showDirectoryPicker;
    if (picker === undefined) {
      setFolderNote("This browser can't open the folder picker — use the terminal command below.");
      return;
    }
    setFolderBusy(true);
    setFolderNote(null);
    setCandidates(null);
    let name: string;
    try {
      name = (await picker()).name;
    } catch {
      // The picker dialog was dismissed; staying silent is the correct UX.
      setFolderBusy(false);
      return;
    }
    let resolved: FolderResolveResponse;
    try {
      resolved = await api.resolveFolder(name);
    } catch (error) {
      setFolderNote(error instanceof Error ? error.message : "Could not find that folder.");
      setFolderBusy(false);
      return;
    }
    if (resolved.matches.length === 0) {
      setFolderNote(`No folder called "${name}" found on this computer.`);
      setFolderBusy(false);
      return;
    }
    if (resolved.matches.length === 1 && resolved.matches[0] !== undefined) {
      await enablePickedPath(resolved.matches[0]);
      return;
    }
    setCandidates({ name, matches: resolved.matches, truncated: resolved.truncated });
    setFolderBusy(false);
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
      default:
        return;
    }
  }

  const daemonState: DaemonState = !healthOk
    ? "offline"
    : health?.mode === "demo"
      ? "degraded"
      : "ready";
  const demo = health?.mode === "demo";
  // Materialized projects, not allowlist folders: one repo with two enabled
  // folders is one repo, matching the projects page.
  const headerRepos = projects?.length ?? repos?.length ?? null;
  const daemonLabel =
    daemonState === "ready" ? "Running" : daemonState === "degraded" ? "Demo" : "Not running";
  const dot = dotStyle(daemonState);
  const reduced = reducedMotion;

  const content = (
    <>
      <div className="flex items-start gap-2.5 px-4 py-3">
        <span
          aria-hidden="true"
          className="mt-[5px] inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: dot.background, border: dot.border }}
        />
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold leading-5 text-dusk-ink">Echo local</p>
          <p className="truncate text-[11px] tracking-wide text-dusk-muted">
            {daemonLabel}
            {health ? ` · v${health.version}` : ""}
            {headerRepos !== null ? ` · ${headerRepos} repos` : ""}
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
          aria-expanded={reposOpen}
          className="echo-settings-row flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/[0.07] focus-visible:bg-white/[0.07] focus-visible:outline-none"
          onClick={() => setReposOpen((was) => !was)}
        >
          <span aria-hidden className="inline-flex shrink-0 text-dusk-muted">
            <HugeiconsIcon icon={Folder01Icon} size={16} strokeWidth={1.8} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-dusk-ink">Captured repositories</span>
            <span className="block truncate text-[11px] text-dusk-muted">
              {reposFailed
                ? "Can't load — is Echo running?"
                : projects === null && repos === null
                  ? "Loading…"
                  : (projects ?? []).length === 0 && (repos ?? []).length === 0
                    ? "None enabled yet"
                    : (projects ?? []).length > 0
                      ? (projects ?? [])
                          .slice(0, 2)
                          .map((p) => displayProjectName(p))
                          .join(" · ") +
                        ((projects ?? []).length > 2 ? ` · +${(projects ?? []).length - 2}` : "")
                      : (repos ?? [])
                          .slice(0, 2)
                          .map((r) => r.split("/").pop() ?? r)
                          .join(" · ") +
                        ((repos ?? []).length > 2 ? ` · +${(repos ?? []).length - 2}` : "")}
            </span>
          </span>
          <span
            aria-hidden
            className={`inline-flex shrink-0 text-dusk-faint transition-transform ${reposOpen ? "rotate-90" : ""}`}
          >
            <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.8} />
          </span>
        </button>
        {reposOpen ? (
          <div className="ml-7">
            {(() => {
              const grouped = groupedRepos();
              if (grouped === null) {
                return (repos ?? []).map((path) => (
                  <RepoRow
                    key={path}
                    name={path.split("/").pop() ?? path}
                    title={path}
                    busy={removePath !== null}
                    disabled={demo}
                    onRemove={() => void handleRemoveRepo(path)}
                    removeLabel={`Stop capturing ${path}`}
                  />
                ));
              }
              return (
                <>
                  {grouped.groups.map(({ project, paths }) => (
                    <div
                      key={project.id}
                      className="echo-settings-row flex w-full items-center gap-2 rounded-lg px-3 py-1.5 transition-colors hover:bg-white/[0.07]"
                    >
                      <span aria-hidden className="inline-flex shrink-0 text-dusk-faint">
                        <HugeiconsIcon icon={Folder01Icon} size={14} strokeWidth={1.8} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-dusk-ink">
                          {displayProjectName(project)}
                        </span>
                        <span
                          title={paths.join("\n")}
                          className="block truncate font-mono text-[11px] text-dusk-muted"
                        >
                          {paths.length > 1
                            ? `${paths.length} folders`
                            : (paths[0]?.split("/").pop() ?? project.root)}
                        </span>
                      </span>
                      <button
                        type="button"
                        disabled={demo || removePath !== null}
                        onClick={() => void handleRemoveProject(project, paths)}
                        title={`Stop capturing ${displayProjectName(project)}`}
                        aria-label={`Stop capturing ${displayProjectName(project)}`}
                        className="inline-flex shrink-0 cursor-pointer items-center rounded p-1 text-dusk-muted transition-colors hover:text-dusk-fail disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={1.8} />
                      </button>
                    </div>
                  ))}
                  {grouped.stale.length > 0 ? (
                    <>
                      <p className="px-3 pt-1 text-[11px] text-dusk-muted">
                        These folders are gone — remove them to tidy up.
                      </p>
                      {grouped.stale.map((path) => (
                        <RepoRow
                          key={path}
                          name={path.split("/").pop() ?? path}
                          title={path}
                          busy={removePath !== null}
                          disabled={demo}
                          onRemove={() => void handleRemoveRepo(path)}
                          removeLabel={`Stop capturing ${path}`}
                        />
                      ))}
                    </>
                  ) : null}
                </>
              );
            })()}
            {reposNote !== null ? (
              <p
                className={`px-3 py-1 text-[11px] ${reposNote.ok ? "text-dusk-pass" : "text-dusk-fail"}`}
              >
                {reposNote.text}
              </p>
            ) : null}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-stop="item"
              data-label="Open projects"
              className="echo-settings-row flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-white/[0.07] focus-visible:bg-white/[0.07] focus-visible:outline-none"
              onClick={() => {
                requestClose(false, () => void navigate("/projects"));
              }}
            >
              <span className="min-w-0 flex-1 truncate text-[13px] text-dusk-muted">
                Open all projects
              </span>
              <span aria-hidden className="inline-flex shrink-0 text-dusk-faint">
                <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.8} />
              </span>
            </button>
          </div>
        ) : null}
        {candidates !== null ? (
          <>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-stop="item"
              data-label="Back to settings"
              className="echo-settings-row flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/[0.07] focus-visible:bg-white/[0.07] focus-visible:outline-none"
              onClick={() => setCandidates(null)}
            >
              <span aria-hidden className="inline-flex shrink-0 text-dusk-muted">
                <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.8} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-dusk-ink">
                  Picked &ldquo;{candidates.name}&rdquo;
                </span>
                <span className="block truncate text-[11px] text-dusk-muted">
                  {candidates.matches.length} matches — choose the right one
                </span>
              </span>
            </button>
            {candidates.matches.map((match) => (
              <button
                key={match}
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-stop="item"
                data-label={`Enable ${match}`}
                disabled={folderBusy}
                className="echo-settings-row flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/[0.07] focus-visible:bg-white/[0.07] focus-visible:outline-none disabled:opacity-50"
                onClick={() => {
                  setFolderBusy(true);
                  setFolderNote(null);
                  void enablePickedPath(match);
                }}
              >
                <span aria-hidden className="inline-flex shrink-0 text-dusk-muted">
                  <HugeiconsIcon icon={Folder01Icon} size={16} strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1">
                  <span title={match} className="block truncate font-mono text-xs text-dusk-ink">
                    {match}
                  </span>
                </span>
              </button>
            ))}
            {candidates.truncated ? (
              <p className="px-3 py-1 text-[11px] text-dusk-muted">
                That&apos;s the first batch — for deeper folders, use the terminal command below.
              </p>
            ) : null}
          </>
        ) : (
          <>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-stop="item"
              data-label="Capture Muse sessions"
              disabled={demo || hooksBusy}
              className="echo-settings-row flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/[0.07] focus-visible:bg-white/[0.07] focus-visible:outline-none disabled:opacity-60"
              onClick={() => void handleInstallHooks()}
            >
              <span aria-hidden className="inline-flex shrink-0 text-dusk-muted">
                <HugeiconsIcon icon={Plug01Icon} size={16} strokeWidth={1.8} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-dusk-ink">
                  {hooksBusy ? "Setting up…" : "Capture Muse sessions"}
                </span>
                <span className="block truncate text-[11px] text-dusk-muted">
                  {hooksNote ??
                    (demo
                      ? "Turned off in the demo"
                      : hooks === null
                        ? "Loading…"
                        : hooks.installed
                          ? `On — following all ${hooks.totalEvents}`
                          : hooks.eventsInstalled.length > 0
                            ? `Partly on — ${hooks.eventsInstalled.length} of ${hooks.totalEvents}, tap to finish`
                            : "Off — turn on so Echo can follow your Muse work")}
                </span>
              </span>
              {hooks?.installed ? (
                <span aria-hidden className="inline-flex shrink-0 text-dusk-pass">
                  <HugeiconsIcon icon={Tick01Icon} size={14} strokeWidth={1.8} />
                </span>
              ) : null}
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              data-stop="item"
              data-label="Add folder"
              disabled={demo || folderBusy}
              className="echo-settings-row flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/[0.07] focus-visible:bg-white/[0.07] focus-visible:outline-none disabled:opacity-60"
              onClick={() => void handlePickFolder()}
            >
              <span aria-hidden className="inline-flex shrink-0 text-dusk-muted">
                <HugeiconsIcon icon={FolderAddIcon} size={16} strokeWidth={1.8} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-dusk-ink">
                  {folderBusy ? "Looking for that folder…" : "Add a folder…"}
                </span>
                <span className="block truncate text-[11px] text-dusk-muted">
                  {folderNote ?? (demo ? "Turned off in the demo" : "Choose from this computer")}
                </span>
              </span>
              <span aria-hidden className="inline-flex shrink-0 text-dusk-faint">
                <HugeiconsIcon icon={ArrowRight01Icon} size={14} strokeWidth={1.8} />
              </span>
            </button>
          </>
        )}
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          data-stop="item"
          data-label="Add from the terminal"
          className="echo-settings-row flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-white/[0.07] focus-visible:bg-white/[0.07] focus-visible:outline-none"
          onClick={() => void handleCopyEnable()}
        >
          <span aria-hidden className="inline-flex shrink-0 text-dusk-muted">
            <HugeiconsIcon icon={Copy01Icon} size={16} strokeWidth={1.8} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-dusk-ink">
              {copied === "enable" ? "Copied" : "Add from the terminal"}
            </span>
            <span className="block truncate font-mono text-[11px] text-dusk-muted">
              echo-cli enable &lt;path&gt;
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
      className="echo-settings-panel fixed z-50 w-[min(340px,calc(100vw-24px))] rounded-xl bg-[rgba(28,28,48,0.85)] shadow-[0_20px_48px_rgba(0,0,0,0.5)] backdrop-blur-xl backdrop-saturate-150"
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
        className="echo-settings-sheet fixed inset-x-3 bottom-3 z-50 rounded-xl bg-[rgba(28,28,48,0.92)] p-1 shadow-[0_20px_48px_rgba(0,0,0,0.5)] backdrop-blur-xl backdrop-saturate-150"
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
