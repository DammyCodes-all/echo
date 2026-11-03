/**
 * Hand-authored flow diagram. Fixed 140×240 coordinate space, three rails
 * from the source lane into the tape hub, each with a traveling pulse in
 * Dusk's accent gradient. Source-lane nodes are fixed h-18 with gap-3, so the
 * rail endpoints match their centers exactly.
 */
const RAILS = [
  { d: "M 0 36 C 58 36, 88 120, 140 120", delay: "0s" },
  { d: "M 0 120 L 140 120", delay: "0.9s" },
  { d: "M 0 204 C 58 204, 88 120, 140 120", delay: "1.8s" },
] as const;

export function FlowBeams() {
  return (
    <svg
      viewBox="0 0 140 240"
      width="140"
      height="240"
      className="hidden shrink-0 md:block"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="beam-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#A9CFFF" stopOpacity="0" />
          <stop offset="0.45" stopColor="#A9CFFF" />
          <stop offset="0.75" stopColor="#2D88FF" />
          <stop offset="1" stopColor="#2D88FF" stopOpacity="0" />
        </linearGradient>
      </defs>
      {RAILS.map(({ d }) => (
        <path key={d} d={d} fill="none" stroke="#2E2E4A" strokeWidth="1.5" strokeLinecap="round" />
      ))}
      {RAILS.map(({ d, delay }) => (
        <path
          key={`${d}-pulse`}
          d={d}
          fill="none"
          stroke="url(#beam-grad)"
          strokeWidth="2"
          strokeLinecap="round"
          className="beam-pulse"
          style={{ animationDelay: delay }}
        />
      ))}
    </svg>
  );
}
