export interface ItemVariant { id: string; name: string; price_minor: number; weight_text: string | null; is_available: boolean }
export interface ModifierOption { id: string; name: string; price_minor: number; min_quantity: number; max_quantity: number; default_quantity: number; is_available: boolean; price_by_variant: Record<string, number> }
export interface ModifierGroup { id: string; name: string; min_quantity: number; max_quantity: number; options: ModifierOption[] }
export interface ItemConfiguration { variants: ItemVariant[]; default_variant_id: string | null; modifier_groups: ModifierGroup[] }
export const emptyConfiguration = (): ItemConfiguration => ({ variants: [], default_variant_id: null, modifier_groups: [] });

export interface MenuItem {
  configuration: ItemConfiguration;
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  price_minor: number;
  currency: string;
  weight_text: string | null;
  ingredients: string | null;
  allergens: string[];
  is_available: boolean;
  source_confidence: number | null;
}

export interface MenuSection {
  id: string;
  name: string;
  items: MenuItem[];
}

export interface DraftMenu {
  revision: string;
  menu_id: string;
  draft_version_id: string;
  sections: MenuSection[];
}

export interface PublishResult {
  published_version_id: string;
  version: number;
  section_count: number;
  item_count: number;
  public_id: string;
  published_at: string;
}

export interface MenuLinks {
  public_menu_url: string;
  max_deep_link: string | null;
}

export interface MenuMediaResult {
  url: string;
  width: number;
  height: number;
  size_bytes: number;
}

export interface PublicMenu {
  restaurant: {
    public_id: string;
    name: string;
    description: string | null;
    address: string | null;
  };
  site: import("./site").SiteConfig;
  version: number | null;
  published_at: string | null;
  sections: MenuSection[];
}

type SaveMenuItem = Omit<MenuItem, "id">;
type SaveMenuSection = { name: string; items: SaveMenuItem[] };

async function parseJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(payload?.detail ?? `${fallback}: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function draftPayload(sections: MenuSection[]): { sections: SaveMenuSection[] } {
  return {
    sections: sections.map(({ name, items }) => ({
      name,
      items: items.map(({ id: _id, ...item }) => item),
    })),
  };
}

export async function fetchDraftMenu(restaurantId: string): Promise<DraftMenu> {
  const response = await fetch(`/api/v1/restaurants/${restaurantId}/menu/draft`, {
    credentials: "include",
  });
  return parseJson<DraftMenu>(response, "Не удалось загрузить черновик");
}

export async function saveDraftMenu(
  restaurantId: string,
  sections: MenuSection[],
  expectedRevision: string,
): Promise<DraftMenu> {
  const response = await fetch(`/api/v1/restaurants/${restaurantId}/menu/draft`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...draftPayload(sections), expected_revision: expectedRevision }),
  });
  return parseJson<DraftMenu>(response, "Не удалось сохранить черновик");
}

export async function uploadMenuMedia(
  restaurantId: string,
  file: File,
): Promise<MenuMediaResult> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`/api/v1/restaurants/${restaurantId}/menu/media`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  return parseJson<MenuMediaResult>(response, "Не удалось загрузить фотографию блюда");
}

export async function publishMenu(restaurantId: string, expectedRevision: string): Promise<PublishResult> {
  const response = await fetch(`/api/v1/restaurants/${restaurantId}/menu/publish`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_revision: expectedRevision }),
  });
  return parseJson<PublishResult>(response, "Не удалось опубликовать меню");
}

export async function fetchMenuLinks(restaurantId: string): Promise<MenuLinks> {
  const response = await fetch(`/api/v1/restaurants/${restaurantId}/menu/links`, {
    credentials: "include",
  });
  return parseJson<MenuLinks>(response, "Не удалось получить ссылки на меню");
}

export async function fetchPublicMenu(publicId: string): Promise<PublicMenu> {
  const response = await fetch(`/api/v1/public/restaurants/${encodeURIComponent(publicId)}/menu`);
  return parseJson<PublicMenu>(response, "Меню не найдено");
}

export async function quoteMenuItem(publicId: string, itemId: string, variantId: string | null, modifiers: { option_id: string; quantity: number }[], signal?: AbortSignal): Promise<{ unit_price_minor: number }> {
  return parseJson(await fetch(`/api/v1/public/restaurants/${encodeURIComponent(publicId)}/menu/quote`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal,
    body: JSON.stringify({ item_id: itemId, variant_id: variantId, modifiers, quantity: 1 }),
  }), "Не удалось рассчитать цену");
}
