// Bot notifications and point dialogs (P1-DOC-11, P1-TASK-48/64). The server decides every
// right; these calls only read and change the signed-in user's own settings.

export type AdminKind =
  | "a1_import_ready"
  | "a2_admin_joined"
  | "a3_menu_published"
  | "a4_draft_stale"
  | "a5_stop_list_demand"
  | "a6_empty_searches"
  | "a7_weekly_summary"
  | "a8_point_message";

export interface NotificationSettings {
  bot: { messages_allowed: boolean; allow_link: string | null; support_link: string | null };
  venues: Array<{ restaurant_id: string; public_id: string; name: string; notifications_enabled: boolean }>;
  items: Array<{ point_id: string; public_id: string; point_name: string; item_key: string; item_name: string }>;
  admin: Array<{ venue_id: string; name: string; public_id: string; kinds: Array<{ kind: AdminKind; enabled: boolean }> }>;
}

export interface ConversationSummary {
  id: string;
  number: number;
  status: "open" | "answered" | "closed";
  guest_name: string;
  last_message: string;
  last_message_at: string;
  unread: number;
  blocked: boolean;
}

export interface ConversationDetail extends ConversationSummary {
  point_id: string;
  point_name: string;
  messages: Array<{ id: string; direction: "in" | "out"; text: string; photo_count: number; created_at: string }>;
}

async function request<T>(url: string, fallback: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: unknown } | null;
    throw new Error(typeof payload?.detail === "string" ? payload.detail : fallback);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const fetchNotificationSettings = () =>
  request<NotificationSettings>("/api/v1/me/notifications", "Не удалось загрузить настройки");

export const setVenueNews = (restaurantId: string, enabled: boolean) =>
  request<void>(`/api/v1/me/notifications/venues/${restaurantId}`, "Не удалось сохранить", json("PUT", { enabled }));

export const removeItemSubscription = (pointId: string, itemKey: string) =>
  request<void>(`/api/v1/me/notifications/items/${pointId}/${itemKey}`, "Не удалось отписаться", { method: "DELETE" });

export const setAdminKind = (venueId: string, kind: AdminKind, enabled: boolean) =>
  request<void>(`/api/v1/me/notifications/admin/${venueId}/${kind}`, "Не удалось сохранить", json("PUT", { enabled }));

export const stopAllMarketing = () =>
  request<void>("/api/v1/me/notifications/stop", "Не удалось отписаться", { method: "POST" });

const publicBase = (publicId: string) => `/api/v1/public/restaurants/${encodeURIComponent(publicId)}`;

export const fetchItemSubscription = (publicId: string, itemKey: string) =>
  request<{ subscribed: boolean }>(`${publicBase(publicId)}/items/${itemKey}/subscription`, "Не удалось загрузить");

export const setItemSubscription = (publicId: string, itemKey: string, subscribed: boolean) =>
  request<{ subscribed: boolean }>(`${publicBase(publicId)}/items/${itemKey}/subscription`, "Не удалось сохранить", json("PUT", { subscribed }));

export const fetchChatLink = (publicId: string) =>
  request<{ url: string | null }>(`${publicBase(publicId)}/chat-link`, "Не удалось открыть чат");

export const listConversations = (pointId: string) =>
  request<ConversationSummary[]>(`/api/v1/points/${pointId}/conversations`, "Не удалось загрузить сообщения");

export const fetchConversation = (id: string) =>
  request<ConversationDetail>(`/api/v1/conversations/${id}`, "Не удалось открыть диалог");

export const replyToConversation = (id: string, text: string) =>
  request<ConversationDetail>(`/api/v1/conversations/${id}/reply`, "Не удалось отправить ответ", json("POST", { text }));

export const closeConversation = (id: string) =>
  request<void>(`/api/v1/conversations/${id}/close`, "Не удалось закрыть диалог", { method: "POST" });

export const setGuestBlocked = (id: string, blocked: boolean) =>
  request<void>(`/api/v1/conversations/${id}/block`, "Не удалось изменить блокировку", json("PUT", { blocked }));
