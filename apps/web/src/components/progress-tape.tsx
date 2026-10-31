import type { Change, ProgressState } from "@echo/contracts";

type ProgressTapeProps = {
  changes: Change[];
  /** Index of the change on screen; changes.length means past-the-end. */
  currentIndex: number;
  getState: (change: Pick<Change, "id" | "version">) => ProgressState | undefined;
  isLive: boolean;
  onJump: (index: number) => void;
};

function segmentClass(state: ProgressState | undefined, isCurrent: boolean): string {
  const base = "h-1.5 flex-1 rounded-full transition-colors";
  const ring = isCurrent ? " outline-2 outline-offset-2 outline-dusk-accent" : "";
  if (state === "understood") return `${base} bg-dusk-accent${ring}`;
  if (state === "skipped") return `${base} bg-dusk-muted/50${ring}`;
  if (state === "viewed") return `${base} bg-dusk-pill${ring}`;
  return `${base} bg-dusk-track${ring}`;
}

function segmentLabel(index: number, state: ProgressState | undefined): string {
  if (state === "understood") return `Change ${index + 1}: got it`;
  if (state === "skipped") return `Change ${index + 1}: skipped`;
  if (state === "viewed") return `Change ${index + 1}: seen`;
  return `Change ${index + 1}: not seen yet`;
}

export function ProgressTape({
  changes,
  currentIndex,
  getState,
  isLive,
  onJump,
}: ProgressTapeProps) {
  const understood = changes.filter((change) => getState(change) === "understood").length;
  const skipped = changes.filter((change) => getState(change) === "skipped").length;
  return (
    <div>
      <div className="flex items-center gap-1.5">
        {changes.map((change, index) => (
          <button
            key={`${change.id}@v${change.version}`}
            type="button"
            onClick={() => onJump(index)}
            title={change.title}
            aria-label={segmentLabel(index, getState(change))}
            aria-current={index === currentIndex ? "step" : undefined}
            className={segmentClass(getState(change), index === currentIndex)}
          />
        ))}
        {isLive ? (
          <span
            title="Session still going — new changes land here"
            className="h-1.5 w-4 rounded-full bg-dusk-peach-wash outline-1 outline-dusk-peach"
          />
        ) : null}
      </div>
      <p className="mt-2 font-mono text-xs text-dusk-muted">
        {understood} of {changes.length} got it{skipped > 0 ? ` · ${skipped} skipped` : ""}
        {isLive ? " · live" : ""}
      </p>
    </div>
  );
}
