// Public API of the guest menu. Own module of `features/guest` so the new menu
// does not change the shared `src/api/*`.
// Everything here is anonymous: the guest sees only the published snapshot.

import type { MenuItem, MenuSection } from "../../api/menu";
import type { SiteConfig } from "../../api/site";

export type { ItemConfiguration, ItemVariant, MenuItem, MenuSection, ModifierGroup, ModifierOption } from "../../api/menu";
export type { SiteConfig } from "../../api/site";

/** A position may carry a stable `item_key`. */
export type GuestItem = MenuItem & { item_key?: string | null };
export type GuestSection = Omit<MenuSection, "items"> & { items: GuestItem[] };

export interface GuestRestaurant {
  public_id: string;
  name: string;
  description: string | null;
  address: string | null;
  venue_name?: string;
  timezone?: string;
  /** Seeded demo venue (server flag): shows the «Демо» mark. */
  is_demo?: boolean;
}

/** One menu tab of a point. */
export interface GuestMenuTab {
  menu_id: string;
  title: string;
  version: number;
  published_at: string | null;
  sections: GuestSection[];
}

/** Raw public response: `menus[]` is present after the spec, absent on older servers. */
export interface GuestMenuResponse {
  restaurant: GuestRestaurant;
  site: SiteConfig;
  version: number | null;
  published_at: string | null;
  sections: GuestSection[];
  menus?: GuestMenuTab[];
  /** «Синица, что взять?»: whether the AI answers now (absent on older servers). */
  assistant?: GuestAssistant;
}

export interface GuestAssistant {
  available: boolean;
  /** "mock" — the labelled demo adapter: answers are marked «Демо-ИИ». */
  provider: "openai" | "mock" | null;
}

/** Normalised snapshot the screen works with: always a list of tabs (possibly one or none). */
export interface GuestMenu {
  restaurant: GuestRestaurant;
  site: SiteConfig;
  tabs: GuestMenuTab[];
  /** `menus[]` came back empty: nothing is shown at this point right now (display hours). */
  outsideHours: boolean;
  assistant: GuestAssistant;
}

export class GuestApiError extends Error {
  constructor(message: string, readonly status: number, readonly detail: string | null = null) {
    super(message);
    this.name = "GuestApiError";
  }
}

async function readDetail(response: Response): Promise<string | null> {
  const payload = (await response.json().catch(() => null)) as { detail?: unknown } | null;
  return typeof payload?.detail === "string" ? payload.detail : null;
}

/** Both formats → tabs. A snapshot without a published version has no tabs. */
export function normalizeGuestMenu(raw: GuestMenuResponse): GuestMenu {
  const tabs = Array.isArray(raw.menus)
    ? raw.menus.filter((tab) => Array.isArray(tab.sections))
    : raw.version === null
      ? []
      : [{ menu_id: "main", title: "Меню", version: raw.version, published_at: raw.published_at, sections: raw.sections ?? [] }];
  // the spec backend answers 200 only when something is published; an empty `menus[]` then means
  // no menu is shown right now (display hours), and the top-level `version` is null in that case.
  const outsideHours = Array.isArray(raw.menus) && raw.menus.length === 0;
  const assistant: GuestAssistant = raw.assistant?.available
    ? { available: true, provider: raw.assistant.provider ?? null }
    : { available: false, provider: null };
  return { restaurant: raw.restaurant, site: raw.site, tabs, outsideHours, assistant };
}

export async function fetchGuestMenu(publicId: string, signal?: AbortSignal): Promise<GuestMenu> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/public/restaurants/${encodeURIComponent(publicId)}/menu`, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new GuestApiError("Нет связи с сервером", 0);
  }
  if (!response.ok) {
    const detail = await readDetail(response);
    throw new GuestApiError(detail ?? `Меню не загрузилось (${response.status})`, response.status, detail);
  }
  return normalizeGuestMenu((await response.json()) as GuestMenuResponse);
}

/** 404 for a point that exists but has nothing published yet (backend detail «Site not published»). */
export function isNotPublished(error: unknown): boolean {
  return error instanceof GuestApiError && error.status === 404 && error.detail === "Site not published";
}

export function isNotFound(error: unknown): boolean {
  return error instanceof GuestApiError && error.status === 404 && !isNotPublished(error);
}

export interface QuoteSelection {
  itemId: string;
  variantId: string | null;
  modifiers: { option_id: string; quantity: number }[];
  /** Portions in the line (1–99); the server returns the line total for it. Default 1. */
  quantity?: number;
}

export interface QuoteResult {
  unit_price_minor: number;
  /** Line total for `quantity` portions, computed by the server. */
  total_price_minor?: number;
  menu_id?: string;
  published_version_id?: string;
}

/**
 * Server price of one portion. 409 — the position is gone or
 * unavailable in the current snapshot, 422 — the selection breaks the item's rules.
 */
export async function quoteGuestItem(publicId: string, selection: QuoteSelection, signal?: AbortSignal): Promise<QuoteResult> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/public/restaurants/${encodeURIComponent(publicId)}/menu/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        item_id: selection.itemId,
        variant_id: selection.variantId,
        modifiers: selection.modifiers,
        quantity: selection.quantity ?? 1,
      }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new GuestApiError("Нет связи с сервером", 0);
  }
  if (!response.ok) {
    const detail = await readDetail(response);
    throw new GuestApiError(detail ?? "Не удалось рассчитать цену", response.status, detail);
  }
  return (await response.json()) as QuoteResult;
}

/** Money is integer kopecks; the UI shows roubles with kopecks only when there are any. */
export function formatMoney(minor: number): string {
  const roubles = minor / 100;
  return `${roubles.toLocaleString("ru-RU", { minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 })} ₽`;
}

/** A position suggested by «Синица, что взять?»; the price comes from the server snapshot. */
export interface AskPick {
  id: string;
  item_key: string;
  menu_id: string;
  name: string;
  section: string;
  price_minor: number;
  has_sizes: boolean;
  image_url: string | null;
}

export interface AskAnswer {
  /** "ai" — picked by the model and filtered by the server; "fallback" — without AI. */
  source: "ai" | "fallback";
  provider: "openai" | "mock" | null;
  reason: string;
  notice: string | null;
  items: AskPick[];
  /** The daily AI limit was reached (429): the picks are without AI. */
  limited?: boolean;
}

/**
 * «Синица, что взять?». The guest text is sent as data; the server answers only
 * with available positions of this point's published menu. 429 carries picks without AI.
 */
export async function askSinitsa(publicId: string, question: string, signal?: AbortSignal): Promise<AskAnswer> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/public/restaurants/${encodeURIComponent(publicId)}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      signal,
      body: JSON.stringify({ question }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new GuestApiError("Нет связи с сервером", 0);
  }
  if (response.status === 429) {
    const payload = (await response.json().catch(() => null)) as { detail?: { message?: string; items?: AskPick[] } } | null;
    return {
      source: "fallback",
      provider: null,
      reason: "",
      notice: payload?.detail?.message ?? "Лимит ИИ на сегодня исчерпан",
      items: Array.isArray(payload?.detail?.items) ? payload!.detail!.items! : [],
      limited: true,
    };
  }
  if (!response.ok) {
    const detail = await readDetail(response);
    throw new GuestApiError(detail ?? "Не удалось получить подсказку", response.status, detail);
  }
  return (await response.json()) as AskAnswer;
}
