export function EchoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="3.4" fill="#EEEEFA" />
      <path
        d="M8.5 16a7.5 7.5 0 0 1 7.5-7.5"
        stroke="#2D88FF"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path
        d="M23.5 16a7.5 7.5 0 0 0-7.5 7.5"
        stroke="#2D88FF"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <path d="M4 16a12 12 0 0 1 12-12" stroke="#3E3E5C" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M28 16a12 12 0 0 0-12 12" stroke="#3E3E5C" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
