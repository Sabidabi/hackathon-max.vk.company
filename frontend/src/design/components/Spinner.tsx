/**
 * Loading indicator. Decorative by default (the surrounding text says what is loading);
 * pass `label` when the spinner is the only signal.
 */
export function Spinner({ size = 24, label, className }: { size?: number; label?: string; className?: string }) {
  return (
    <span
      className={["s-spinner", className].filter(Boolean).join(" ")}
      style={{ width: size, height: size }}
      role={label ? "status" : undefined}
      aria-hidden={label ? undefined : true}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none">
        <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
        <path d="M21.5 12A9.5 9.5 0 0 0 12 2.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      {label && <span className="s-visually-hidden">{label}</span>}
    </span>
  );
}
