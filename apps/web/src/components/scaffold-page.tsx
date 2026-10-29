import { Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Link } from "react-router";

type ScaffoldPageProps = {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  breadcrumb?: { backTo: string; backLabel: string };
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
          <div className="flex items-center gap-2 text-sm">
            <Link
              to={breadcrumb.backTo}
              className="text-dusk-muted transition-colors hover:text-dusk-ink"
            >
              ← {breadcrumb.backLabel}
            </Link>
            <span aria-hidden className="text-dusk-faint">
              /
            </span>
            <h1
              aria-current="page"
              className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-dusk-ink"
            >
              <span aria-hidden className="inline-flex text-dusk-muted">
                <HugeiconsIcon icon={Folder01Icon} size={22} strokeWidth={1.8} />
              </span>
              {title}
            </h1>
          </div>
        </nav>
      ) : (
        <div className="max-w-2xl space-y-3">
          {eyebrow ? (
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-dusk-muted">
              {eyebrow}
            </p>
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
      <p className="font-mono text-xs uppercase tracking-widest text-dusk-muted">{label}</p>
    </div>
  );
}
