import type { ProjectTechStackKind } from "@echo/contracts";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  CodeIcon,
  Database01Icon,
  Folder01Icon,
  Layers01Icon,
  ServerStack01Icon,
  SkipForwardIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { api } from "../api";
import { SessionCard } from "../components/session-card";

const TECH_KIND_ICON: Record<ProjectTechStackKind, typeof CodeIcon> = {
  language: CodeIcon,
  framework: Layers01Icon,
  build: Wrench01Icon,
  data: Database01Icon,
  infra: ServerStack01Icon,
};

export function ProjectOverviewPage() {
  const { projectId = "" } = useParams();
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.project(projectId),
  });
  const sessions = useQuery({
    queryKey: ["sessions", projectId],
    queryFn: () => api.sessions(projectId),
    refetchInterval: 5000,
  });

  const techStack = useQuery({
    queryKey: ["tech-stack", projectId],
    queryFn: () => api.techStack(projectId),
    // Background regens land as a new artifact; poll so the sidebar
    // converges without a manual refresh. Stale data stays visible meanwhile.
    refetchInterval: 30_000,
  });

  // Server order is last activity DESC: only genuinely live sessions move.
  const list = sessions.data ?? [];
  const checked = list.filter((s) => s.checkStatus === "checked").length;
  const skipped = list.filter((s) => s.checkStatus === "skipped").length;
  const highRisk = list.reduce((sum, s) => sum + s.highRiskCount, 0);

  return (
    <div className="lg:grid lg:grid-cols-[300px_minmax(0,1fr)] lg:items-start lg:gap-6">
      <aside className="sticky top-[72px] max-h-[calc(100vh-96px)] space-y-4 overflow-y-auto overscroll-contain">
        <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
          <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
            Project summary
          </p>
          {techStack.isPending ? (
            <div aria-hidden className="mt-2 space-y-2 motion-safe:animate-pulse">
              <div className="h-3.5 rounded-dusk-code bg-dusk-pill" />
              <div className="h-3.5 w-4/5 rounded-dusk-code bg-dusk-pill" />
              <div className="h-3.5 w-3/5 rounded-dusk-code bg-dusk-pill" />
            </div>
          ) : (
            <p className="mt-2 text-sm leading-6 text-dusk-ink">
              {techStack.data?.purpose ??
                "Echo reviews what this repo's coding agents did — one short story per session, then a check that calibration matches reality."}
            </p>
          )}
          <p className="mt-3 flex items-center gap-1.5 break-all font-mono text-xs text-dusk-muted">
            <span aria-hidden className="inline-flex shrink-0">
              <HugeiconsIcon icon={Folder01Icon} size={14} strokeWidth={1.8} />
            </span>
            <span>
              {project.isPending ? (
                <span role="status" aria-label="Loading project location">
                  <span
                    aria-hidden
                    className="inline-block h-3 w-40 rounded-dusk-code bg-dusk-pill motion-safe:animate-pulse"
                  />
                </span>
              ) : (
                (project.data?.root ?? "…")
              )}
            </span>
          </p>
        </div>
        <div className="rounded-dusk-card bg-dusk-surface px-6 py-5">
          <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
            Current state
          </p>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-5 text-sm">
            <div>
              <div className="flex items-center gap-1.5">
                <span aria-hidden className="inline-flex text-dusk-accent">
                  <HugeiconsIcon icon={Layers01Icon} size={20} strokeWidth={1.8} />
                </span>
                <dd className="text-2xl font-semibold tracking-tight tabular-nums">
                  {list.length}
                </dd>
              </div>
              <dt className="mt-1 text-xs text-dusk-muted">Sessions</dt>
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span aria-hidden className="inline-flex text-dusk-pass">
                  <HugeiconsIcon icon={CheckmarkCircle02Icon} size={20} strokeWidth={1.8} />
                </span>
                <dd className="text-2xl font-semibold tracking-tight tabular-nums">{checked}</dd>
              </div>
              <dt className="mt-1 text-xs text-dusk-muted">Checked</dt>
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span aria-hidden className="inline-flex text-dusk-peach">
                  <HugeiconsIcon icon={SkipForwardIcon} size={20} strokeWidth={1.8} />
                </span>
                <dd className="text-2xl font-semibold tracking-tight tabular-nums">{skipped}</dd>
              </div>
              <dt className="mt-1 text-xs text-dusk-muted">Skipped</dt>
            </div>
            <div>
              <div className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={`inline-flex ${highRisk > 0 ? "text-dusk-fail" : "text-dusk-muted"}`}
                >
                  <HugeiconsIcon icon={Alert02Icon} size={20} strokeWidth={1.8} />
                </span>
                <dd
                  className={`text-2xl font-semibold tracking-tight tabular-nums ${highRisk > 0 ? "text-dusk-fail" : ""}`}
                >
                  {highRisk}
                </dd>
              </div>
              <dt className="mt-1 text-xs text-dusk-muted">High-risk cards</dt>
            </div>
          </dl>
          {techStack.isPending ? (
            <div className="mt-4 border-t border-dusk-hairline pt-4">
              <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
                Tech stack
              </p>
              <div aria-hidden className="mt-3 space-y-2.5 motion-safe:animate-pulse">
                {["w-24", "w-32", "w-20"].map((width) => (
                  <div key={width} className="flex items-center gap-2">
                    <div className="size-3.5 shrink-0 rounded-full bg-dusk-pill" />
                    <div className={`h-3 rounded-dusk-code bg-dusk-pill ${width}`} />
                    <div className="ml-auto h-3 w-12 rounded-dusk-code bg-dusk-pill" />
                  </div>
                ))}
              </div>
            </div>
          ) : techStack.isError ? (
            <div className="mt-4 border-t border-dusk-hairline pt-4">
              <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
                Tech stack
              </p>
              <p className="mt-3 text-xs text-dusk-fail">Couldn&apos;t load the tech stack.</p>
              <button
                type="button"
                onClick={() => void techStack.refetch()}
                className="mt-2 rounded-dusk-code bg-dusk-pill px-3 py-1.5 text-xs text-dusk-ink transition-colors hover:text-dusk-accent-soft"
              >
                Retry
              </button>
            </div>
          ) : techStack.data && techStack.data.items.length > 0 ? (
            <div className="mt-4 border-t border-dusk-hairline pt-4">
              <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">
                Tech stack
              </p>
              <dl className="mt-3 space-y-2 text-xs">
                {techStack.data.items.map((item) => (
                  <div key={`${item.kind}-${item.name}`} className="flex items-center gap-2">
                    <span aria-hidden className="inline-flex text-dusk-muted">
                      <HugeiconsIcon icon={TECH_KIND_ICON[item.kind]} size={14} strokeWidth={1.8} />
                    </span>
                    <dt className="text-dusk-ink">{item.name}</dt>
                    <dd className="ml-auto text-right capitalize text-dusk-muted">{item.kind}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </div>
      </aside>

      <section className="mt-8 space-y-3 lg:mt-0">
        <h2 className="text-xl font-semibold tracking-tight">Agent sessions</h2>
        {sessions.isPending ? (
          <div role="status" aria-label="Loading sessions" className="grid gap-5 sm:grid-cols-2">
            {["first", "second", "third", "fourth"].map((key) => (
              <div
                key={key}
                aria-hidden
                className="rounded-[20px] border border-transparent bg-dusk-surface px-6 py-5 motion-safe:animate-pulse"
              >
                <div className="mb-4 h-4 w-3/4 rounded-dusk-code bg-dusk-pill" />
                <div className="h-4 w-1/2 rounded-dusk-code bg-dusk-pill" />
                <div className="mt-4 flex items-center justify-between gap-4 border-t border-dusk-hairline pt-3.5">
                  <div className="h-3.5 w-20 rounded-dusk-code bg-dusk-pill" />
                  <div className="h-7 w-24 rounded-dusk-code bg-dusk-pill" />
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {sessions.isError ? (
          <div className="rounded-dusk-card border border-dusk-fail/40 bg-dusk-fail-wash p-8 text-sm text-dusk-fail">
            Could not load sessions.
          </div>
        ) : null}
        {sessions.data && sessions.data.length === 0 ? (
          <div className="rounded-dusk-card bg-dusk-surface p-8 text-sm text-dusk-muted">
            {project.data && project.data.sessionCount > 0
              ? "No sessions to show right now — active sessions appear a minute after they go quiet."
              : "No sessions captured for this project yet."}
          </div>
        ) : null}
        {list.length > 0 ? (
          <div className="grid gap-5 sm:grid-cols-2">
            {list.map((session) => (
              <SessionCard key={session.id} session={session} />
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
