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
