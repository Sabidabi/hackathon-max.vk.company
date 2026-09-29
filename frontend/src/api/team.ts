// Venue admins.
// One equal role `admin`; `is_creator` only protects the creator from removal.

export interface TeamMember {
  user_id: string;
  max_user_id: number;
  display_name: string;
  role: "admin";
  is_creator: boolean;
}

export interface TeamInvite {
  id: string;
  /** Null for a link invite that anyone who opens it may accept. */
  max_user_id: number | null;
  role: "admin";
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

export interface CreatedInvite extends TeamInvite {
  invite_url: string;
  /** `https://max.ru/<bot>?startapp=inv_<token>` when the bot is configured. */
  max_deep_link: string | null;
  web_url: string;
}

export interface InvitePreview {
  restaurant_name: string;
  invited_by: string;
  expires_at: string;
  already_admin: boolean;
}

/** A failed team request with its HTTP status: screens pick their message by it. */
export class TeamRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "TeamRequestError";
  }
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new TeamRequestError("Нет связи с сервером. Проверьте подключение.", 0);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: unknown } | null;
    const detail = typeof payload?.detail === "string" ? payload.detail : `Ошибка ${response.status}`;
    throw new TeamRequestError(detail, response.status);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export const listMembers = (pointId: string) => request<TeamMember[]>(`/restaurants/${pointId}/members`);
export const listInvites = (pointId: string) => request<TeamInvite[]>(`/restaurants/${pointId}/invites`);
/** A one-time admin link for 24 h, not bound to a MAX ID. */
export const createInvite = (pointId: string) => request<CreatedInvite>(`/restaurants/${pointId}/invites`, "POST");
export const revokeInvite = (pointId: string, inviteId: string) => request<void>(`/restaurants/${pointId}/invites/${inviteId}`, "DELETE");
export const removeMember = (pointId: string, userId: string) => request<void>(`/restaurants/${pointId}/members/${userId}`, "DELETE");
/** 409 for the last admin and for the creator: the detail explains why. */
export const leaveVenue = (pointId: string) => request<void>(`/restaurants/${pointId}/leave`, "POST");
export const previewInvite = (token: string) => request<InvitePreview>(`/invites/${token}/preview`);
/** Token in the body, not in the URL path: it stays out of access logs. */
export const acceptInvite = (token: string) => request<TeamMember>("/invites/accept", "POST", { token });
