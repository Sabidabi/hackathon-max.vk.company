// Venue, its points, menu library, assignments and the point stop-list (P1-DOC-15,
// API of P1-PLAN-7). Rights are checked by the server on every call; foreign ids answer 404.
import { ApiError, parseApiJson } from "./errors";
import type { MenuItem, MenuSection } from "./menu";
import type { Restaurant } from "./restaurants";

export interface VenuePoint {
  id: string;
  public_id: string;
  name: string;
  address: string | null;
  timezone: string;
}

export interface Venue {
  id: string;
  name: string;
  is_creator: boolean;
  created_at: string;
  points: VenuePoint[];
}

export interface MenuSummary {
  id: string;
  venue_id: string;
  title: string;
  source: "manual" | "iiko" | string;
  archived_at: string | null;
  point_ids: string[];
  draft_version_id: string | null;
  current_published_version_id: string | null;
  published_version: number | null;
  published_at: string | null;
  unpublished_changes: number;
  updated_at: string;
}

export interface LibraryDraft {
  menu_id: string;
  draft_version_id: string;
  revision: string;
  sections: MenuSection[];
}

export interface LibraryPublishResult {
  menu_id: string;
  published_version_id: string;
  version: number;
  section_count: number;
  item_count: number;
  published_at: string;
  point_ids: string[];
}

export interface Assignment {
  menu_id: string;
  title: string;
  sort_order: number;
  show_from: string | null;
  show_to: string | null;
  has_published_version: boolean;
}

export interface PointAssignments {
  point_id: string;
  revision: string;
  assignments: Assignment[];
}

export interface PointOverride {
  available: boolean | null;
  price_minor: number | null;
  variant_prices: Record<string, number>;
}

export interface PointItemState {
  item_key: string;
  item_id: string;
  name: string;
  section: string;
  menu_price_minor: number;
  menu_is_available: boolean;
  effective_price_minor: number;
  effective_is_available: boolean;
  availability_error: string | null;
  variants: { variant_id: string; name: string; is_available: boolean; menu_price_minor: number; effective_price_minor: number }[];
  override: PointOverride | null;
}

export interface PointItems {
  point_id: string;
  menus: { menu_id: string; title: string; source: "published" | "draft"; items: PointItemState[] }[];
}

const JSON_HEADERS = { "Content-Type": "application/json" };

async function request<T>(url: string, fallback: string, init: RequestInit = {}): Promise<T> {
  return parseApiJson<T>(await fetch(url, { credentials: "include", ...init }), fallback);
}

const send = (method: string, body: unknown): RequestInit => ({ method, headers: JSON_HEADERS, body: JSON.stringify(body) });

export const venueKeys = {
  venues: ["venues"] as const,
  menus: (venueId: string) => ["venue-menus", venueId] as const,
  draft: (menuId: string) => ["menu-draft", menuId] as const,
  assignments: (pointId: string) => ["point-menus", pointId] as const,
  items: (pointId: string) => ["point-items", pointId] as const,
};

export const listVenues = () => request<Venue[]>("/api/v1/venues", "Не удалось загрузить заведения");

export const createPoint = (venueId: string, payload: { name: string; address?: string | null; timezone?: string }) =>
  request<Restaurant>(`/api/v1/venues/${venueId}/points`, "Не удалось создать точку", send("POST", payload));

export const listVenueMenus = (venueId: string) =>
  request<MenuSummary[]>(`/api/v1/venues/${venueId}/menus`, "Не удалось загрузить меню заведения");

export const createMenu = (venueId: string, title: string) =>
  request<MenuSummary>(`/api/v1/venues/${venueId}/menus`, "Не удалось создать меню", send("POST", { title }));

export const copyMenu = (menuId: string, title: string) =>
  request<MenuSummary>(`/api/v1/menus/${menuId}/copy`, "Не удалось сделать копию", send("POST", { title }));

export const renameMenu = (menuId: string, title: string) =>
  request<MenuSummary>(`/api/v1/menus/${menuId}`, "Не удалось переименовать меню", send("PATCH", { title }));

export const fetchMenuSummary = (menuId: string) => request<MenuSummary>(`/api/v1/menus/${menuId}`, "Не удалось загрузить меню");

export const fetchLibraryDraft = (menuId: string) => request<LibraryDraft>(`/api/v1/menus/${menuId}/draft`, "Не удалось загрузить черновик");

type SaveItem = Omit<MenuItem, "id">;

/** Draft body: positions keep `item_key`, so the point stop-list stays attached. */
export function libraryPayload(sections: MenuSection[]): { sections: { name: string; items: SaveItem[] }[] } {
  return {
    sections: sections.map(({ name, items }) => ({
      name,
      items: items.map(({ id: _id, ...item }) => item),
    })),
  };
}

export const saveLibraryDraft = (menuId: string, sections: MenuSection[], expectedRevision: string, seenVersion: number | null) =>
  request<LibraryDraft>(`/api/v1/menus/${menuId}/draft`, "Не удалось сохранить черновик", send("PUT", {
    ...libraryPayload(sections),
    expected_revision: expectedRevision,
    ...(seenVersion ? { seen_version: seenVersion } : {}),
  }));

export const publishLibraryMenu = (menuId: string, expectedRevision: string, pointIds: string[], seenVersion: number | null) =>
  request<LibraryPublishResult>(`/api/v1/menus/${menuId}/publish`, "Не удалось опубликовать меню", send("POST", {
    expected_revision: expectedRevision,
    point_ids: pointIds,
    ...(seenVersion ? { seen_version: seenVersion } : {}),
  }));

export const fetchPointMenus = (pointId: string) =>
  request<PointAssignments>(`/api/v1/points/${pointId}/menus`, "Не удалось загрузить меню точки");

export const savePointMenus = (
  pointId: string,
  expectedRevision: string,
  assignments: { menu_id: string; show_from?: string | null; show_to?: string | null }[],
) => request<PointAssignments>(`/api/v1/points/${pointId}/menus`, "Не удалось назначить меню", send("PUT", { expected_revision: expectedRevision, assignments }));

export const fetchPointItems = (pointId: string) => request<PointItems>(`/api/v1/points/${pointId}/items`, "Не удалось загрузить наличие точки");

export const patchPointItem = (pointId: string, itemKey: string, patch: { available?: boolean | null; price_minor?: number | null }) =>
  request<{ point_id: string; item_key: string } & PointOverride>(`/api/v1/points/${pointId}/items/${itemKey}`, "Не удалось изменить наличие", send("PATCH", patch));

export const setVenueItemAvailability = (venueId: string, itemKey: string, available: boolean | null, pointIds?: string[]) =>
  request<{ item_key: string; available: boolean | null; point_ids: string[] }>(
    `/api/v1/venues/${venueId}/items/${itemKey}/availability`,
    "Не удалось изменить наличие",
    send("POST", { available, ...(pointIds ? { point_ids: pointIds } : {}) }),
  );

/**
 * Adds or removes one menu on a point, keeping the other tabs, their order and hours.
 * Reads the current assignments first (their revision guards against a parallel change).
 */
export async function setMenuOnPoint(
  pointId: string,
  menuId: string,
  assigned: boolean,
  hours: { show_from: string | null; show_to: string | null } = { show_from: null, show_to: null },
): Promise<PointAssignments> {
  const current = await fetchPointMenus(pointId);
  const others = current.assignments
    .filter((item) => item.menu_id !== menuId)
    .map(({ menu_id, show_from, show_to }) => ({ menu_id, show_from, show_to }));
  const existing = current.assignments.find((item) => item.menu_id === menuId);
  const next = assigned
    ? existing
      ? current.assignments.map(({ menu_id, show_from, show_to }) => (menu_id === menuId ? { menu_id, ...hours } : { menu_id, show_from, show_to }))
      : [...others, { menu_id: menuId, ...hours }]
    : others;
  return savePointMenus(pointId, current.revision, next);
}

export { ApiError };

export const renameVenue = (venueId: string, name: string) =>
  request<Venue>(`/api/v1/venues/${venueId}`, "Не удалось переименовать заведение", send("PATCH", { name }));

// --- Publication check, history and templates (P1-PLAN-9) ---------------------------------

export interface DiffItem { item_key: string; name: string; section: string }
export interface MenuDiff {
  added: DiffItem[];
  removed: DiffItem[];
  changed: (DiffItem & { changes: { field: string; before: unknown; after: unknown }[] })[];
  sections_added: string[];
  sections_removed: string[];
  total_changes: number;
}

export interface PublishProblem {
  code: "empty" | "no_price" | "unavailable_config";
  message: string;
  item_key: string | null;
  item_name: string | null;
  section: string | null;
}

export interface PublishCheck {
  menu_id: string;
  revision: string;
  problems: PublishProblem[];
  diff: MenuDiff;
}

export interface VersionEntry {
  version_id: string;
  version: number;
  status: "published" | "archived";
  is_current: boolean;
  published_at: string | null;
  author: { id: string; display_name: string };
  item_count: number;
}

export const fetchPublishCheck = (menuId: string) =>
  request<PublishCheck>(`/api/v1/menus/${menuId}/publish-check`, "Не удалось проверить меню");

export const listMenuVersions = (menuId: string) =>
  request<VersionEntry[]>(`/api/v1/menus/${menuId}/versions`, "Не удалось загрузить историю");

export const diffMenuVersions = (menuId: string, from: string | number, to: string | number) =>
  request<{ diff: MenuDiff }>(`/api/v1/menus/${menuId}/versions/${from}/diff/${to}`, "Не удалось сравнить версии");

export const restoreMenuVersion = (menuId: string, version: number, expectedRevision: string) =>
  request<LibraryDraft>(`/api/v1/menus/${menuId}/versions/${version}/restore`, "Не удалось вернуть версию", send("POST", { expected_revision: expectedRevision }));

export const applyMenuTemplate = (menuId: string, expectedRevision: string, template: "coffee" = "coffee") =>
  request<LibraryDraft>(`/api/v1/menus/${menuId}/template`, "Не удалось добавить шаблон", send("POST", { template, expected_revision: expectedRevision }));
