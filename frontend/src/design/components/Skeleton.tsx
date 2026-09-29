import type { CSSProperties } from "react";

/**
 * Placeholder with the shape of the content being loaded. Hidden from assistive tech:
 * the container announces loading (e.g. `aria-busy`), not every bar.
 */
export function Skeleton({ width = "100%", height = 16, radius, className }: {
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  radius?: "control" | "card" | "pill";
  className?: string;
}) {
  return (
    <span
      className={["s-skeleton", radius && `s-skeleton--${radius}`, className].filter(Boolean).join(" ")}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
