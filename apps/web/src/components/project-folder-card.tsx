import type { ProjectSummary, SessionSummary } from "@echo/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, formatTime } from "../api";
import { displayProjectName } from "../project-display";
import { compactSessionSummary } from "../session-display";
import GlassFolder, { type ArtRecipe, type FolderFile, hashString } from "./glass-folder-cards";

/** Dusk streak: the workspace at rest, pulled toward the accent. */
const DUSK_ART: ArtRecipe = {
  style: "streak",
  colors: ["#12121f", "#1c1c30", "#2a2a4c", "#3b3b6e", "#8c9bff", "#c9ceff"],
  scale: 0.7,
  warp: 1.6,
  angle: 0.8,
  gloss: 0.35,
  veins: 0.1,
};

function shortTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day}, ${time}`;
}

function checkLine(session: SessionSummary): string {
  const label =
    session.checkStatus === "checked"
      ? "Checked"
      : session.checkStatus === "skipped"
        ? "Skipped"
        : "Not checked";
  return session.highRiskCount > 0 ? `${label} · ${session.highRiskCount} high-risk` : label;
}

function captureLine(session: SessionSummary): string | null {
  if (session.captureState === "ready") return null;
  if (session.captureState === "recording") return "Still recording";
  return `Capture ${session.captureState.replace("_", " ")}`;
}

function sessionFile(session: SessionSummary): FolderFile {
  const when = shortTime(session.lastActivity);
  const first = session.model && when ? `${when} · ${session.model}` : (when ?? session.model);
  const captured = captureLine(session);
  return {
    name: compactSessionSummary(session.summary) ?? "Still recording — story pending…",
    meta: `${session.eventCount} event${session.eventCount === 1 ? "" : "s"}`,
    detail: [first, checkLine(session), captured].filter((line): line is string => line !== null),
    href: `/sessions/${session.id}`,
  };
}

function metaLine(project: ProjectSummary, total: number): string {
  const sessions = `${total} session${total === 1 ? "" : "s"}`;
  return project.lastActivity
    ? `${sessions} · last activity ${formatTime(project.lastActivity)}`
    : sessions;
}

/** Hover preview is a fine-pointer affordance; touch taps navigate directly. */
function canHover(): boolean {
  return window.matchMedia("(hover: hover)").matches;
}

const HOVER_OPEN_DELAY_MS = 150;

/** Pre-load peek: one blank sheet so the resting pocket isn't empty; the load remount swaps in real files. */
const REST_PEEK: FolderFile[] = [{ name: "Loading sessions…" }];

export function ProjectFolderCard({ project, index }: { project: ProjectSummary; index: number }) {
  const navigate = useNavigate();
  const [files, setFiles] = useState<FolderFile[] | null>(null);
  const [total, setTotal] = useState(project.sessionCount);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  // The fetch resolves after the pointer may have left; only open when still wanted.
  const wantOpen = useRef(false);
  const fetching = useRef(false);
  const openTimer = useRef(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // Mirrors files-loaded in a ref so the open handler stays stable: rebinding
  // listeners on load would drop a hover timer queued mid-flight.
  const loadedRef = useRef(false);
  // The folder remounts when files arrive (it owns its list after mount), which
  // drops focus to the body; restore it so keyboard users stay in the preview.
  const refocusOnLoad = useRef(false);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      wantOpen.current = next;
      if (!next) refocusOnLoad.current = false;
      if (next && !loadedRef.current) {
        // A second open while the fetch is in flight opens via the resolver below.
        if (!fetching.current) {
          fetching.current = true;
          void api.sessions(project.id).then(
            (sessions) => {
              fetching.current = false;
              loadedRef.current = true;
              // Only the folder subtree remounts; focus elsewhere (e.g. the
              // view-all link) survives and must not be stolen.
              refocusOnLoad.current =
                wantOpen.current &&
                (wrapRef.current?.querySelector(".gf-root")?.contains(document.activeElement) ??
                  false);
              setTotal(sessions.length);
              setFiles(sessions.slice(0, 3).map(sessionFile));
              setFailed(false);
              // The ready folder remounts closed (appear={false} below); flip
              // to open over two frames so the first preview lifts from inside
              // instead of dropping in or snapping open.
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  if (wantOpen.current) setOpen(true);
                });
              });
            },
            () => {
              fetching.current = false;
              setFailed(true);
              if (wantOpen.current) setOpen(true);
            },
          );
        }
        return;
      }
      setOpen(next);
    },
    [project.id],
  );

  useEffect(() => {
    if (files !== null && open && refocusOnLoad.current) {
      refocusOnLoad.current = false;
      wrapRef.current?.querySelector<HTMLElement>(".gf-hit")?.focus({ preventScroll: true });
    }
  }, [files, open]);

  // Hover/focus only previews; every action stays on a real button or link.
  // Native listeners, like the folder's own pointer tracking, keep the
  // static wrapper out of the operable-element lint.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const queueOpen = () => {
      window.clearTimeout(openTimer.current);
      openTimer.current = window.setTimeout(() => handleOpenChange(true), HOVER_OPEN_DELAY_MS);
    };
    const close = () => {
      window.clearTimeout(openTimer.current);
      handleOpenChange(false);
    };
    const onEnter = (event: PointerEvent) => {
      if (event.pointerType === "touch" || !canHover()) return;
      queueOpen();
    };
    const onLeave = (event: PointerEvent) => {
      if (event.pointerType === "touch" || !canHover()) return;
      // DOM churn under a stationary cursor (load remount, link mount) fires
      // phantom boundary events; only a pointer truly outside closes.
      const under = document.elementFromPoint(event.clientX, event.clientY);
      if (under instanceof Node && el.contains(under)) return;
      close();
    };
    const onFocusIn = () => {
      if (!canHover()) return;
      window.clearTimeout(openTimer.current);
      handleOpenChange(true);
    };
    const onFocusOut = (event: FocusEvent) => {
      // The load remount destroys the focused element; the refocus effect owns
      // that transition, so a blur it causes must not close the preview.
      if (refocusOnLoad.current) return;
      if (el.contains(event.relatedTarget as Node | null)) return;
      close();
    };
    el.addEventListener("pointerenter", onEnter);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);
    return () => {
      window.clearTimeout(openTimer.current);
      el.removeEventListener("pointerenter", onEnter);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
    };
  }, [handleOpenChange]);

  const openProject = () => navigate(`/projects/${project.id}`);

  return (
    <div ref={wrapRef} className="flex flex-col items-center gap-3">
      <GlassFolder
        key={files === null ? "shell" : "ready"}
        label={displayProjectName(project)}
        meta={metaLine(project, total)}
        tone="dark"
        art={DUSK_ART}
        seed={hashString(project.id)}
        files={files ?? (total > 0 ? REST_PEEK : [])}
        action="more"
        menu={[{ label: "Open project", onSelect: openProject }]}
        open={open}
        onOpenChange={handleOpenChange}
        onHitActivate={openProject}
        width={320}
        appear={files === null}
        appearDelay={files === null ? index * 120 : 0}
      />
      {open ? (
        failed ? (
          <p className="text-sm text-dusk-muted">Could not load sessions.</p>
        ) : files !== null && files.length === 0 ? (
          <p className="max-w-80 text-center text-sm text-dusk-muted">
            No sessions yet — run a Muse or OpenCode session in this repo to capture one.
          </p>
        ) : total > 0 ? (
          <Link
            to={`/projects/${project.id}`}
            className="text-sm text-dusk-muted underline underline-offset-4 hover:text-dusk-ink"
            // The folder closes on outside pointerdown; without this the link
            // unmounts before its click fires and navigation never happens.
            onPointerDown={(event) => event.stopPropagation()}
          >
            View all {total} session{total === 1 ? "" : "s"} →
          </Link>
        ) : null
      ) : null}
    </div>
  );
}
