const REPO_URL = import.meta.env.VITE_ECHO_REPO_URL as string | undefined;
const WRITEUP_URL = import.meta.env.VITE_ECHO_WRITEUP_URL as string | undefined;

function DemoLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-semibold text-dusk-accent-soft underline underline-offset-4"
    >
      {children}
    </a>
  );
}

/** Slim read-only marker above every demo page. Links render only when set. */
export function DemoBanner() {
  return (
    <div className="border-b border-dusk-rail bg-dusk-surface">
      <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-4 gap-y-1 px-6 py-2 text-[13px] leading-5 text-dusk-muted">
        <p>
          <strong className="font-semibold text-dusk-ink">Read-only demo.</strong> One baked session
          — questions and checks are graded live but never stored.
        </p>
        {REPO_URL || WRITEUP_URL ? (
          <p className="ml-auto flex gap-4">
            {REPO_URL ? <DemoLink href={REPO_URL}>Repository</DemoLink> : null}
            {WRITEUP_URL ? <DemoLink href={WRITEUP_URL}>Write-up</DemoLink> : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function demoLinks(): { repo: string | undefined; writeup: string | undefined } {
  return { repo: REPO_URL, writeup: WRITEUP_URL };
}
