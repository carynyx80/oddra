/**
 * The Oddra mark: a centre circle split by the halfway line, with the ball (lime) sitting just off the spot.
 * Works at 16px (favicon) and as a token image.
 */
export function Mark({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="11" stroke="currentColor" strokeWidth="3" />
      <path d="M16 2v28" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <circle cx="23.5" cy="8.5" r="4" fill="#B8FF65" />
    </svg>
  );
}

/** The ODDRA wordmark: drawn strokes in the mark's line weight, so it never depends on a loaded font. */
export function Wordmark({ height = 14, className = "" }: { height?: number; className?: string }) {
  return (
    <svg height={height} viewBox="0 0 223 40" fill="none" className={className} role="img" aria-label="Oddra">
      <g stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="20" cy="20" r="16.5" />
        <path d="M55.5 3.5V36.5H65.5A16.5 16.5 0 0 0 65.5 3.5Z" />
        <path d="M101 3.5V36.5H111A16.5 16.5 0 0 0 111 3.5Z" />
        <path d="M146.5 36.5V3.5H158.5A9.25 9.25 0 0 1 158.5 22H146.5M159 22L170.5 36.5" />
        <path d="M189.5 36.5L204.5 3.5L219.5 36.5M195.4 25H213.6" />
      </g>
    </svg>
  );
}

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <Mark size={24} />
      <Wordmark height={14} />
    </span>
  );
}
