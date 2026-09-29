import { useMemo } from "react";

import { encodeQr, qrPath } from "../qr";

const QUIET_ZONE = 4;

/**
 * QR code drawn as SVG from the local encoder (no network, no dependency). Dark modules use
 * --sinitsa-ink on --sinitsa-surface: 17.7:1, scanners need the quiet zone kept white.
 */
export function QrCode({ value, size = 184, label }: { value: string; size?: number; label: string }) {
  const symbol = useMemo(() => {
    try {
      const modules = encodeQr(value, { errorCorrection: "M" });
      return { dimension: modules.length + QUIET_ZONE * 2, path: qrPath(modules, QUIET_ZONE) };
    } catch {
      return null;
    }
  }, [value]);
  if (!symbol) return null;
  return (
    <svg
      className="s-qr"
      viewBox={`0 0 ${symbol.dimension} ${symbol.dimension}`}
      width={size}
      height={size}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={symbol.dimension} height={symbol.dimension} className="s-qr__background" />
      <path d={symbol.path} className="s-qr__modules" />
    </svg>
  );
}
