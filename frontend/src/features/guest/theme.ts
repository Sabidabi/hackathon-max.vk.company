// Venue theme → design tokens (P1-DOC-3 «Темы меню заведения»). The guest menu is dressed in
// the venue's published colours: the same `--sinitsa-*` variables the design components read
// are redefined on the menu root (and on <body> while the menu is open, for portalled sheets),
// never on :root — the brand palette of the rest of the app stays intact.

import type { SiteConfig } from "./api";

type Rgb = [number, number, number];

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function parseHex(value: string | null | undefined): Rgb | null {
  if (!value || !HEX.test(value.trim())) return null;
  let hex = value.trim().slice(1);
  if (hex.length === 3) hex = hex.split("").map((char) => char + char).join("");
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as Rgb;
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** `weight` of `a` mixed with `b`. */
function mix(a: Rgb, b: Rgb, weight: number): Rgb {
  return [0, 1, 2].map((index) => a[index] * weight + b[index] * (1 - weight)) as Rgb;
}

const WHITE: Rgb = [255, 255, 255];
const INK: Rgb = [21, 24, 33];

/** Moves `color` towards black or white until it reaches `ratio` against `background`. */
function ensureContrast(color: Rgb, background: Rgb, ratio: number): Rgb {
  if (contrast(color, background) >= ratio) return color;
  const target = luminance(background) > 0.4 ? [0, 0, 0] as Rgb : WHITE;
  for (let step = 0.1; step <= 1; step += 0.1) {
    const candidate = mix(target, color, step);
    if (contrast(candidate, background) >= ratio) return candidate;
  }
  return target;
}

/** CSS custom properties for a published venue theme. Unknown colours keep the defaults. */
export function themeVariables(site: SiteConfig | null | undefined): Record<string, string> {
  if (!site) return {};
  const surface = parseHex(site.surface_color) ?? WHITE;
  const canvas = parseHex(site.background_color) ?? surface;
  const text = ensureContrast(parseHex(site.text_color) ?? INK, surface, 7);
  // The accent is a control colour: it must stay visible on the surface (≥ 3:1).
  const primary = ensureContrast(parseHex(site.primary_color) ?? parseHex(site.icon_color) ?? INK, surface, 3);
  const onPrimary = contrast(WHITE, primary) >= contrast(INK, primary) ? WHITE : INK;
  const muted = ensureContrast(mix(text, surface, 0.68), surface, 4.5);
  const dark = luminance(surface) < 0.3;
  return {
    "--sinitsa-blue": toHex(primary),
    "--sinitsa-blue-press": toHex(mix(dark ? WHITE : [0, 0, 0], primary, 0.16)),
    "--sinitsa-on-blue": toHex(onPrimary),
    "--sinitsa-ink": toHex(text),
    "--sinitsa-canvas": toHex(canvas),
    "--sinitsa-surface": toHex(surface),
    "--sinitsa-muted": toHex(muted),
    "--sinitsa-sky": toHex(mix(primary, surface, 0.12)),
    "--sinitsa-line": toHex(mix(text, surface, 0.14)),
    "--sinitsa-line-strong": toHex(ensureContrast(mix(text, surface, 0.45), surface, 3)),
    "--sinitsa-skeleton": toHex(mix(text, surface, 0.08)),
    "--sinitsa-skeleton-shine": toHex(mix(text, surface, 0.03)),
    "--sinitsa-focus-ring": `0 0 0 2px ${toHex(surface)}, 0 0 0 4px ${toHex(primary)}`,
    "--guest-accent": toHex(ensureContrast(parseHex(site.icon_color) ?? primary, surface, 3)),
    "color-scheme": dark ? "dark" : "light",
  };
}

/** «Плитки» of a published theme as data attributes on the menu root; CSS does the rest. */
export function tileAttributes(site: SiteConfig | null | undefined): Record<string, string> {
  return {
    "data-layout": site?.menu_layout ?? "grid",
    "data-card": site?.card_style ?? "soft",
    "data-radius": site?.card_radius ?? "soft",
    "data-ratio": site?.image_ratio ?? "square",
    "data-add": site?.add_button ?? "round",
    "data-heading": site?.heading_font ?? "sans",
    "data-font": site?.body_font ?? "sans",
    "data-desc": (site?.show_description ?? true) ? "on" : "off",
    "data-weight": (site?.show_weight ?? true) ? "on" : "off",
  };
}
