type SkeletonProps = {
  className?: string;
};

export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={`motion-safe:animate-pulse rounded-dusk-code bg-dusk-pill/70 ${className}`}
    />
  );
}

export function SkeletonLines({ rows = 3, className = "" }: { rows?: number; className?: string }) {
  return (
    <div aria-hidden className={`space-y-2 motion-safe:animate-pulse ${className}`}>
      {Array.from({ length: rows }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: lines are static and never reorder
          key={`skeleton-line-${index}`}
          className={`h-3.5 rounded-dusk-code bg-dusk-pill ${index === rows - 1 && rows > 1 ? "w-3/5" : ""}`}
        />
      ))}
    </div>
  );
}

export function SkeletonCard({ className = "" }: SkeletonProps) {
  return (
    <div aria-hidden className={`rounded-dusk-card bg-dusk-surface p-6 ${className}`}>
      <div className="space-y-3 motion-safe:animate-pulse">
        <div className="h-4 w-2/3 rounded-dusk-code bg-dusk-pill" />
        <div className="h-3.5 rounded-dusk-code bg-dusk-pill" />
        <div className="h-3.5 w-4/5 rounded-dusk-code bg-dusk-pill" />
      </div>
    </div>
  );
}

/**
 * Architecture loading state mirroring ProjectArchitecturePage's loaded
 * geometry: a 520px canvas with node-like cards where the graph will land,
 * beside the 360px chat rail. Content swaps in with no layout shift.
 */
export function ArchitectureSkeleton() {
  return (
    <div aria-hidden className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="relative h-[520px] overflow-hidden motion-safe:animate-pulse">
        <div className="absolute top-[12%] left-[8%] h-16 w-44 rounded-dusk-card bg-dusk-pill/40" />
        <div className="absolute top-[8%] left-[46%] h-16 w-52 rounded-dusk-card bg-dusk-pill/50" />
        <div className="absolute top-[38%] left-[28%] h-16 w-48 rounded-dusk-card bg-dusk-pill/40" />
        <div className="absolute top-[34%] left-[66%] h-16 w-40 rounded-dusk-card bg-dusk-pill/50" />
        <div className="absolute top-[64%] left-[12%] h-16 w-48 rounded-dusk-card bg-dusk-pill/50" />
        <div className="absolute top-[68%] left-[56%] h-16 w-52 rounded-dusk-card bg-dusk-pill/40" />
      </div>
      <div className="hidden space-y-3 rounded-dusk-card bg-dusk-surface p-6 lg:block">
        <div className="motion-safe:animate-pulse">
          <div className="h-4 w-2/3 rounded-dusk-code bg-dusk-pill" />
          <div className="mt-3 space-y-2">
            <div className="h-3.5 rounded-dusk-code bg-dusk-pill/70" />
            <div className="h-3.5 w-4/5 rounded-dusk-code bg-dusk-pill/70" />
            <div className="h-3.5 w-3/5 rounded-dusk-code bg-dusk-pill/70" />
          </div>
          <div className="mt-6 h-10 rounded-dusk-pill bg-dusk-pill/50" />
        </div>
      </div>
    </div>
  );
}

/**
 * Folder-shaped loading card mirroring ProjectFolderCard's closed geometry:
 * a 320px folder (tab + body + art zone + bottom-left label lines) so the /
 * grid swaps in place with no layout shift. Total height (~307px) matches the
 * GlassFolder (H + HEADROOM) * k box at width 320.
 */
export function ProjectFolderSkeleton() {
  return (
    <div aria-hidden className="flex w-[320px] max-w-full flex-col items-center">
      <div className="w-full motion-safe:animate-pulse">
        <div className="ml-8 h-6 w-28 rounded-t-lg bg-dusk-surface" />
        <div className="relative -mt-px h-[283px] w-full rounded-dusk-card border border-dusk-hairline bg-dusk-surface">
          <div className="absolute inset-x-6 top-6 h-32 rounded-dusk-code bg-dusk-pill/40" />
          <div className="absolute bottom-8 left-7 space-y-2">
            <div className="h-4 w-40 rounded-dusk-code bg-dusk-pill/60" />
            <div className="h-3 w-28 rounded-dusk-code bg-dusk-pill/40" />
          </div>
          <div className="absolute bottom-7 right-7 size-12 rounded-2xl bg-dusk-pill/40" />
        </div>
      </div>
    </div>
  );
}
