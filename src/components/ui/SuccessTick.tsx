/**
 * Animated success confirmation. The tick draws only after the caller has a
 * confirmed server success. Motion is purely visual and stops immediately for
 * users who prefer reduced motion.
 */
export function SuccessTick({
  size = 48,
  className = "",
  label = "Success",
}: {
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 52 52"
      role="img"
      aria-label={label}
      className={`success-tick ${className}`}
    >
      <circle className="success-tick__ring" cx="26" cy="26" r="23" fill="none" />
      <path
        className="success-tick__mark"
        fill="none"
        d="M15 27.5l7.2 7.2L37.5 19"
      />
    </svg>
  );
}

export function SuccessBanner({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="success-panel" role="status" aria-live="polite">
      <SuccessTick size={34} label={title} />
      <div className="min-w-0">
        <p className="font-semibold text-emerald-900">{title}</p>
        {children && <div className="text-sm text-emerald-800 mt-0.5">{children}</div>}
      </div>
    </div>
  );
}
