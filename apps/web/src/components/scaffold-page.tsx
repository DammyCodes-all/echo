import { Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";

type CrumbIcon = Parameters<typeof HugeiconsIcon>[0]["icon"];

/** Display caps for crumb/title text; the full text stays on `title`. */
const CRUMB_CAP = 32;
const TITLE_CAP = 48;

function cap(text: string, max: number): string {
  const clean = text.trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

type ScaffoldPageProps = {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  breadcrumb?: {
    backTo: string;
    backLabel: string;
    /** Middle crumbs between the back link and the title, e.g. project. */
    trail?: Array<{ label: string; to: string }>;
    /** Icon beside the title; the folder stays the default. */
    titleIcon?: CrumbIcon;
    /** Small quiet title for pages whose content owns the hierarchy. */
    quietTitle?: boolean;
    /** True while the title row has no data: a shimmer bar instead of text. */
    titleLoading?: boolean;
  };
  children?: ReactNode;
};

export function ScaffoldPage({
  eyebrow,
  title,
  description,
  breadcrumb,
  children,
}: ScaffoldPageProps) {
  return (
    <section className="space-y-8">
      {breadcrumb ? (
        <nav
          aria-label="Breadcrumb"
          className="sticky top-0 z-10 -mx-6 bg-dusk-base/95 px-6 py-3 backdrop-blur"
        >
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <Link
              to={breadcrumb.backTo}
              className="shrink-0 text-dusk-muted transition-colors hover:text-dusk-ink"
            >
              ← {breadcrumb.backLabel}
            </Link>
            <span aria-hidden className="shrink-0 text-dusk-faint">
              /
            </span>
            {breadcrumb.trail?.map((crumb) => (
              <Fragment key={crumb.to}>
                <Link
                  to={crumb.to}
                  title={crumb.label}
                  className="flex min-w-0 items-center gap-1.5 text-dusk-muted transition-colors hover:text-dusk-ink"
                >
                  <span aria-hidden className="inline-flex shrink-0">
                    <HugeiconsIcon icon={Folder01Icon} size={16} strokeWidth={1.8} />
                  </span>
                  <span className="truncate">{cap(crumb.label, CRUMB_CAP)}</span>
                </Link>
                <span aria-hidden className="shrink-0 text-dusk-faint">
                  /
                </span>
              </Fragment>
            ))}
            <h1
              aria-current="page"
              className={
                breadcrumb.quietTitle
                  ? "flex min-w-0 items-center gap-2 text-sm font-medium text-dusk-muted"
                  : "flex min-w-0 items-center gap-2 text-2xl font-semibold tracking-tight text-dusk-ink"
              }
            >
              <span aria-hidden className="inline-flex shrink-0 text-dusk-muted">
                <HugeiconsIcon
                  icon={breadcrumb.titleIcon ?? Folder01Icon}
                  size={breadcrumb.quietTitle ? 16 : 22}
                  strokeWidth={1.8}
                />
              </span>
              {breadcrumb.titleLoading ? (
                <>
                  <span className="sr-only">Loading…</span>
                  <span
                    aria-hidden
                    className="h-7 w-56 max-w-full rounded-dusk-code bg-dusk-pill motion-safe:animate-pulse"
                  />
                </>
              ) : (
                <span className="truncate" title={title}>
                  {cap(title, TITLE_CAP)}
                </span>
              )}
            </h1>
          </div>
        </nav>
      ) : (
        <div className="max-w-2xl space-y-3">
          {eyebrow ? (
            <p className="text-xs uppercase tracking-[0.2em] text-dusk-muted">{eyebrow}</p>
          ) : null}
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="text-sm leading-6 text-dusk-muted">{description}</p> : null}
        </div>
      )}
      {children}
    </section>
  );
}

export function Panel({ label }: { label: string }) {
  return (
    <div className="h-72 rounded-dusk-card bg-dusk-surface p-6">
      <p className="text-xs uppercase tracking-widest text-dusk-muted">{label}</p>
    </div>
  );
}
