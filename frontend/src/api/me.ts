// The signed-in user's own context. Everything is scoped to the session
// user on the server; the client only navigates by it.

export interface HomePoint {
  id: string;
  public_id: string;
  name: string;
  address: string | null;
}

export interface HomeAdminVenue {
  id: string;
  public_id: string;
  name: string;
  is_creator: boolean;
  has_published_menu: boolean;
  unpublished_changes: number;
  points: HomePoint[];
}

export interface HomeVenue {
  public_id: string;
  name: string;
  address: string | null;
}

export interface HomeRecentVenue extends HomeVenue {
  last_opened_at: string;
}

export interface HomeFavoriteVenue extends HomeVenue {
  notifications_enabled: boolean;
}

export interface HomeData {
  display_name: string;
  first_name: string;
  is_admin: boolean;
  admin_venues: HomeAdminVenue[];
  recent: HomeRecentVenue[];
  favorites: HomeFavoriteVenue[];
}

/** Query key shared by Home and the screens that change its lists (menu visit, invite, connect). */
export const HOME_QUERY_KEY = ["me-home"] as const;

export async function fetchHome(): Promise<HomeData> {
  const response = await fetch("/api/v1/me/home", { credentials: "include" });
  if (!response.ok) throw new Error(`Главная не загрузилась (${response.status})`);
  return response.json() as Promise<HomeData>;
}

/** Remembers that the signed-in user opened this venue's menu (Home «Недавние»). */
export async function recordRecentVisit(publicId: string): Promise<void> {
  const response = await fetch("/api/v1/me/recent", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ public_id: publicId }),
  });
  if (!response.ok) throw new Error(`Recent visit returned ${response.status}`);
}
