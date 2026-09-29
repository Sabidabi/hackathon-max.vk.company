import { prepareImageForUpload, TOO_LARGE_MESSAGE } from "../lib/image";

export type SiteTemplate = "modern" | "classic" | "cafe" | "noir";
export type SiteThemeMode = "light" | "dark";
export type SiteBlockKind = "hero" | "about" | "menu" | "gallery" | "contacts";
export type MenuLayout = "grid" | "list" | "large";
export type CardStyle = "soft" | "outline" | "flat";
export type CardRadius = "sharp" | "soft" | "round";
export type ImageRatio = "square" | "landscape" | "portrait";
export type AddButton = "round" | "pill";
export type HeadingFont = "sans" | "humanist" | "rounded" | "serif" | "elegant" | "mono";
export type BodyFont = "sans" | "humanist" | "serif";
export type SiteImageKind = "logo" | "cover" | "gallery" | "background";

export interface SiteBlock {
  kind: SiteBlockKind;
  visible: boolean;
  title: string | null;
}

export interface SiteConfig {
  template: SiteTemplate;
  theme_mode: SiteThemeMode;
  primary_color: string;
  background_color: string;
  surface_color: string;
  text_color: string;
  icon_color: string;
  background_image_url: string | null;
  background_overlay: number;
  font_scale: number;
  /** «Плитки»: optional so configs saved before the constructor keep working (defaults below). */
  menu_layout?: MenuLayout;
  card_style?: CardStyle;
  card_radius?: CardRadius;
  image_ratio?: ImageRatio;
  add_button?: AddButton;
  heading_font?: HeadingFont;
  body_font?: BodyFont;
  show_description?: boolean;
  show_weight?: boolean;
  tagline: string | null;
  about: string | null;
  phone: string | null;
  hours: string | null;
  booking_url: string | null;
  logo_url: string | null;
  cover_url: string | null;
  gallery_urls: string[];
  blocks: SiteBlock[];
}

export interface SiteDraft {
  revision: string;
  restaurant_id: string;
  config: SiteConfig;
  published_version: number;
  published_at: string | null;
  /** Unreadable colour pairs; the server refuses to publish until they are fixed. */
  contrast_issues?: { pair: string; label: string; ratio: number; required: number }[];
}

export interface SitePublishResult {
  restaurant_id: string;
  published_version: number;
  published_at: string;
}

export interface SiteMediaResult {
  url: string;
  width: number;
  height: number;
  size_bytes: number;
}

async function parseJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(payload?.detail ?? `${fallback}: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchSiteDraft(restaurantId: string): Promise<SiteDraft> {
  const response = await fetch(`/api/v1/restaurants/${restaurantId}/site/draft`, {
    credentials: "include",
  });
  return parseJson<SiteDraft>(response, "Не удалось загрузить сайт");
}

export async function saveSiteDraft(
  restaurantId: string,
  config: SiteConfig,
  expectedRevision: string,
): Promise<SiteDraft> {
  const response = await fetch(`/api/v1/restaurants/${restaurantId}/site/draft`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...config, expected_revision: expectedRevision }),
  });
  return parseJson<SiteDraft>(response, "Не удалось сохранить сайт");
}

export async function publishSite(restaurantId: string, expectedRevision: string): Promise<SitePublishResult> {
  const response = await fetch(`/api/v1/restaurants/${restaurantId}/site/publish`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_revision: expectedRevision }),
  });
  return parseJson<SitePublishResult>(response, "Не удалось опубликовать сайт");
}

export async function uploadSiteMedia(
  restaurantId: string,
  kind: SiteImageKind,
  file: File,
): Promise<SiteMediaResult> {
  const form = new FormData();
  form.append("file", await prepareImageForUpload(file, { kind: kind === "logo" ? "logo" : "photo" }));
  const response = await fetch(`/api/v1/restaurants/${restaurantId}/site/media/${kind}`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (response.status === 413) throw new Error(TOO_LARGE_MESSAGE);
  return parseJson<SiteMediaResult>(response, "Не удалось загрузить изображение");
}
