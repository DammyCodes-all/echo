import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { AskThread } from "../components/ask-thread-panel";
import { demoLinks } from "../components/demo-banner";
import { ScaffoldPage } from "../components/scaffold-page";
import { SessionCard } from "../components/session-card";
import { SkeletonLines } from "../components/skeleton";
import { useDemoMode } from "../hooks/use-demo-mode";
import { queryKeys } from "../query";

function CopyQuestion({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <li className="flex items-baseline justify-between gap-4">
      <span className="text-sm leading-6 text-dusk-ink">{text}</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
        className="shrink-0 text-sm text-dusk-muted underline underline-offset-4 hover:text-dusk-ink"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </li>
  );
}

export function DemoPage() {
  const { isDemo } = useDemoMode();
  const [askOpen, setAskOpen] = useState(false);
  const projectsQuery = useQuery({ queryKey: queryKeys.projects, queryFn: () => api.projects() });
  const project = projectsQuery.data?.[0] ?? null;
  const sessionsQuery = useQuery({
    queryKey: queryKeys.sessions(project?.id ?? ""),
    queryFn: () => api.sessions(project?.id ?? ""),
    enabled: project !== null,
    placeholderData: keepPreviousData,
  });
  const firstSession = sessionsQuery.data?.[0] ?? null;
  const threadQuery = useQuery({
    queryKey: queryKeys.askThread(firstSession?.id ?? ""),
    queryFn: () => api.askThread(firstSession?.id ?? ""),
    enabled: firstSession !== null,
    placeholderData: keepPreviousData,
  });
  const examples =
    threadQuery.data?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.text) ?? [];

  const { repo, writeup } = demoLinks();

  if (projectsQuery.isPending || sessionsQuery.isPending) {
    return (
      <div role="status" aria-label="Loading demo" className="space-y-3">
        <span className="sr-only">Loading demo…</span>
        <SkeletonLines rows={4} />
      </div>
    );
  }
  if (projectsQuery.isError || sessionsQuery.isError || !project || !firstSession) {
    return (
      <ScaffoldPage
        eyebrow={isDemo ? "Hosted demo" : "Demo"}
        title="No session to show"
        description={
          isDemo
            ? "The demo bundle didn't load. Serve it again with echo-cli demo serve."
            : "Enable a project and record a session first — the demo page lists what's here."
        }
      />
    );
  }

  return (
    <ScaffoldPage
      eyebrow={isDemo ? "Hosted demo · read-only" : "Demo"}
      title="Try Echo on a real session"
      description={
        isDemo
          ? "One recorded agent session, baked in. Read the review, take the check, ask why — answers grade live but nothing is stored."
          : "Everything below reads live data. Bake a bundle with echo-cli demo build to preview the hosted demo."
      }
    >
      <div className="space-y-3">
        {(sessionsQuery.data ?? []).map((session) => (
          <SessionCard key={session.id} session={session} />
        ))}
      </div>

      <section aria-label="What you can do" className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">What you can do</h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-dusk-muted">
          <li>
            <Link
              to={`/sessions/${firstSession.id}`}
              className="font-semibold text-dusk-accent-soft underline underline-offset-4"
            >
              Open the review
            </Link>{" "}
            — the changes, the evidence, the questionable bits.
          </li>
          <li>Take the check at the end of the review. It grades what you retained.</li>
          <li>
            <button
              type="button"
              onClick={() => setAskOpen(true)}
              className="font-semibold text-dusk-accent-soft underline underline-offset-4"
            >
              Ask why
            </button>{" "}
            in the thread. It answers from the tape or refuses.
          </li>
        </ol>
      </section>

      {askOpen ? (
        <section aria-label="Ask about this session" className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold tracking-tight">Ask about this session</h2>
            <button
              type="button"
              onClick={() => setAskOpen(false)}
              className="rounded-dusk-code bg-dusk-pill px-3 py-1.5 text-xs text-dusk-ink transition-colors hover:text-dusk-accent-soft"
            >
              Close
            </button>
          </div>
          <AskThread sessionId={firstSession.id} onClearScope={() => undefined} />
        </section>
      ) : null}

      {examples.length > 0 ? (
        <section aria-label="Try asking" className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Try asking</h2>
          <ul className="space-y-2 rounded-dusk-card bg-dusk-surface px-6 py-4">
            {examples.map((text) => (
              <CopyQuestion key={text} text={text} />
            ))}
          </ul>
        </section>
      ) : null}

      {repo || writeup ? (
        <p className="flex gap-5 text-sm">
          {repo ? (
            <a
              href={repo}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-dusk-accent-soft underline underline-offset-4"
            >
              Repository
            </a>
          ) : null}
          {writeup ? (
            <a
              href={writeup}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-dusk-accent-soft underline underline-offset-4"
            >
              Write-up
            </a>
          ) : null}
        </p>
      ) : null}
    </ScaffoldPage>
  );
}
