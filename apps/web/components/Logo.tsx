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

export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <Mark size={22} />
      <span className="font-[family-name:var(--font-display)] text-[17px] font-semibold tracking-[0.14em]">ODDRA</span>
    </span>
  );
}
