// Logos are the brandbook files copied verbatim to public/brand; never redraw or recolour them in code.

/** App icon (blue tile with the white bird). Minimum 32 px. */
export function BrandMark({ size = 64, className }: { size?: number; className?: string }) {
  return <img className={className} src="/brand/sinitsa-app-icon.svg" width={size} height={size} alt="Синица" />;
}

/** Horizontal logo: blue bird + dark name on light backgrounds, white on dark. Minimum 160 px wide. */
export function BrandLockup({ width = 160, tone = "blue", className }: { width?: number; tone?: "blue" | "white"; className?: string }) {
  const height = Math.round((width * 141.58) / 637.36);
  return <img className={className} src={`/brand/sinitsa-lockup-${tone}.svg`} width={width} height={height} alt="Синица" />;
}
