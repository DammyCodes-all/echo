import type { ReactNode } from "react";

type ScaffoldPageProps = {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
};

export function ScaffoldPage({ eyebrow, title, description, children }: ScaffoldPageProps) {
  return (
    <section className="space-y-8">
      <div className="max-w-2xl space-y-3">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-zinc-500">{eyebrow}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm leading-6 text-zinc-400">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function Panel({ label }: { label: string }) {
  return (
    <div className="h-72 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">{label}</p>
    </div>
  );
}
