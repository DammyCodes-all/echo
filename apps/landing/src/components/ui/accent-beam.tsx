import { cn } from "../../lib/utils";

/**
 * Rotating Meta-blue border via conic-gradient + @property. No measurement, no
 * offset-path — the wrapper keeps `border-radius: inherit` so it always hugs
 * the card's corner.
 */
export function AccentBeam({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("accent-beam rounded-[inherit]", className)} />;
}
