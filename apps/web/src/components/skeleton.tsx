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
