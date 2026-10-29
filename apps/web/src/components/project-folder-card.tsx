import type { ProjectSummary, SessionSummary } from "@echo/contracts";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, formatTime } from "../api";
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
  const when = shortTime(session.startedAt);
  const first = session.model && when ? `${when} · ${session.model}` : (when ?? session.model);
  const captured = captureLine(session);
  return {
    name: session.summary ?? "Still recording — story pending…",
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

export function ProjectFolderCard({ project, index }: { project: ProjectSummary; index: number }) {
  const navigate = useNavigate();
  const [files, setFiles] = useState<FolderFile[] | null>(null);
  const [total, setTotal] = useState(project.sessionCount);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (next && files === null) {
      void api.sessions(project.id).then(
        (sessions) => {
          setTotal(sessions.length);
          setFiles(sessions.slice(0, 3).map(sessionFile));
          setOpen(true);
        },
        () => {
          setFailed(true);
          setOpen(true);
        },
      );
      return;
    }
    setOpen(next);
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <GlassFolder
        key={files === null ? "shell" : "ready"}
        label={project.name ?? project.root}
        meta={metaLine(project, total)}
        tone="dark"
        art={DUSK_ART}
        seed={hashString(project.id)}
        files={files ?? []}
        action="more"
        menu={[{ label: "Open project", onSelect: () => navigate(`/projects/${project.id}`) }]}
        open={open}
        onOpenChange={handleOpenChange}
        width={320}
        appear
        appearDelay={index * 120}
      />
      {open ? (
        failed ? (
          <p className="text-sm text-dusk-muted">Could not load sessions.</p>
        ) : (
          <Link
            to={`/projects/${project.id}`}
            className="text-sm text-dusk-muted underline underline-offset-4 hover:text-dusk-ink"
            // The folder closes on outside pointerdown; without this the link
            // unmounts before its click fires and navigation never happens.
            onPointerDown={(event) => event.stopPropagation()}
          >
            View all {total} session{total === 1 ? "" : "s"} →
          </Link>
        )
      ) : null}
    </div>
  );
}
