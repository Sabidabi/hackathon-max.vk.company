// Contrast of the venue theme. The same pairs and thresholds as the
// server (backend/app/sites/contrast.py): text 4.5:1 on cards and on the page background,
// the accent 3:1 on cards. «Исправить» moves the foreground to the nearest readable colour.

export type Rgb = [number, number, number];

export interface ThemeColors {
  primary_color: string;
  background_color: string;
  surface_color: string;
  text_color: string;
}

export type ContrastPair = "text_surface" | "text_background" | "accent_surface";

export interface ContrastIssue {
  pair: ContrastPair;
  label: string;
  field: keyof ThemeColors;
  against: keyof ThemeColors;
  ratio: number;
  required: number;
}

export const CONTRAST_PAIRS: ReadonlyArray<Omit<ContrastIssue, "ratio">> = [
  { pair: "text_surface", label: "Текст на карточках", field: "text_color", against: "surface_color", required: 4.5 },
  { pair: "text_background", label: "Текст на фоне", field: "text_color", against: "background_color", required: 4.5 },
  { pair: "accent_surface", label: "Акцент на карточках", field: "primary_color", against: "surface_color", required: 3 },
];

export function hexToRgb(value: string): Rgb {
  const hex = value.replace("#", "");
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as Rgb;
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(hexToRgb(a)), luminance(hexToRgb(b))].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

export function contrastIssues(colors: ThemeColors): ContrastIssue[] {
  return CONTRAST_PAIRS
    .map((pair) => ({ ...pair, ratio: Math.round(contrastRatio(colors[pair.field], colors[pair.against]) * 100) / 100 }))
    .filter((issue) => contrastRatio(colors[issue.field], colors[issue.against]) < issue.required);
}

/**
 * The closest colour to `color` (same hue, mixed towards black or white in 2% steps) that
 * reaches `ratio` against every background in `against`.
 */
export function nearestReadable(color: string, against: string[], ratio: number): string {
  const base = hexToRgb(color);
  const ok = (candidate: string) => against.every((background) => contrastRatio(candidate, background) >= ratio);
  if (ok(color)) return color.toUpperCase();
  const darkBackground = luminance(hexToRgb(against[0])) < 0.3;
  const targets: Rgb[] = darkBackground ? [[255, 255, 255], [0, 0, 0]] : [[0, 0, 0], [255, 255, 255]];
  for (const target of targets) {
    for (let step = 0.02; step <= 1.0001; step += 0.02) {
      const candidate = rgbToHex(base.map((value, index) => value * (1 - step) + target[index] * step) as Rgb);
      if (ok(candidate)) return candidate;
    }
  }
  return darkBackground ? "#FFFFFF" : "#000000";
}

/** Colours after «Исправить» for one issue: only the foreground of that pair changes. */
export function fixIssue(colors: ThemeColors, issue: ContrastIssue): ThemeColors {
  const backgrounds = CONTRAST_PAIRS.filter((pair) => pair.field === issue.field).map((pair) => colors[pair.against]);
  return { ...colors, [issue.field]: nearestReadable(colors[issue.field], backgrounds, issue.required) };
}
