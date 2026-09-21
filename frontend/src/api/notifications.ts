export interface FavoriteState {
  is_favorite: boolean;
  notifications_enabled: boolean;
}

export interface CampaignPreview {
  eligible_recipients: number;
  can_send_now: boolean;
  next_available_at: string | null;
}

export interface NotificationCampaign {
  id: string;
  kind: "menu_published" | "marketing";
  status: "queued" | "sending" | "completed" | "cancelled";
  title: string;
  body: string;
  recipient_count: number;
  sent_count: number;
  failed_count: number;
  created_at: string;
  completed_at: string | null;
}

async function parseJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(payload?.detail ?? fallback);
  }
  return response.json() as Promise<T>;
}

export async function fetchFavorite(publicId: string) {
  return parseJson<FavoriteState>(
    await fetch(`/api/v1/public/restaurants/${encodeURIComponent(publicId)}/favorite`, {
      credentials: "include",
    }),
    "Не удалось загрузить избранное",
  );
}

export async function updateFavorite(publicId: string, state: FavoriteState) {
  return parseJson<FavoriteState>(
    await fetch(`/api/v1/public/restaurants/${encodeURIComponent(publicId)}/favorite`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    }),
    "Не удалось изменить избранное",
  );
}

export async function fetchCampaignPreview(restaurantId: string) {
  return parseJson<CampaignPreview>(
    await fetch(`/api/v1/restaurants/${restaurantId}/notifications/preview`, {
      credentials: "include",
    }),
    "Не удалось подготовить рассылку",
  );
}

export async function listCampaigns(restaurantId: string) {
  return parseJson<NotificationCampaign[]>(
    await fetch(`/api/v1/restaurants/${restaurantId}/notifications/campaigns`, {
      credentials: "include",
    }),
    "Не удалось загрузить рассылки",
  );
}

export async function createCampaign(
  restaurantId: string,
  payload: { title: string; body: string; idempotency_key: string },
) {
  return parseJson<NotificationCampaign>(
    await fetch(`/api/v1/restaurants/${restaurantId}/notifications/campaigns`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    "Не удалось поставить рассылку в очередь",
  );
}
