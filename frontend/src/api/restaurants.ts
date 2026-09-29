export interface Restaurant {
  id: string;
  public_id: string;
  name: string;
  description: string | null;
  address: string | null;
  /** Every admin has the same rights; the server decides on each request. */
  role: "admin";
  /** The creator cannot be removed by other admins. */
  is_creator: boolean;
  /** Venue (brand) of this point; points of one venue share admins and menus. */
  venue_id: string;
  venue_name: string;
  timezone: string;
  /** Primary menu of the point: its first assigned menu, null when none is assigned. */
  menu_id: string | null;
  draft_version_id: string | null;
  current_published_version_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RestaurantPayload {
  name: string;
  description: string | null;
  address: string | null;
  timezone?: string;
}

async function parseRestaurantResponse(response: Response): Promise<Restaurant> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(payload?.detail ?? `Restaurant request returned ${response.status}`);
  }

  return response.json() as Promise<Restaurant>;
}

export async function listRestaurants(): Promise<Restaurant[]> {
  const response = await fetch("/api/v1/restaurants", { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Restaurant list returned ${response.status}`);
  }
  return response.json() as Promise<Restaurant[]>;
}

export async function createRestaurant(payload: RestaurantPayload): Promise<Restaurant> {
  const response = await fetch("/api/v1/restaurants", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseRestaurantResponse(response);
}

export async function updateRestaurant(
  restaurantId: string,
  payload: RestaurantPayload,
): Promise<Restaurant> {
  const response = await fetch(`/api/v1/restaurants/${restaurantId}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseRestaurantResponse(response);
}
