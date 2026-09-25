export interface TeamMember {
  user_id: string;
  max_user_id: number;
  display_name: string;
  role: "owner" | "manager" | "editor";
}

export interface TeamInvite {
  id: string;
  max_user_id: number;
  role: "manager" | "editor";
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  invite_url?: string;
}

async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: string } | null;
    throw new Error(payload?.detail ?? `Ошибка ${response.status}`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export const listMembers = (pointId: string) => request<TeamMember[]>(`/restaurants/${pointId}/members`);
export const listInvites = (pointId: string) => request<TeamInvite[]>(`/restaurants/${pointId}/invites`);
export const createInvite = (pointId: string, maxUserId: number, role: "manager" | "editor") => request<TeamInvite>(`/restaurants/${pointId}/invites`, "POST", { max_user_id: maxUserId, role });
export const revokeInvite = (pointId: string, inviteId: string) => request<void>(`/restaurants/${pointId}/invites/${inviteId}`, "DELETE");
export const changeRole = (pointId: string, userId: string, role: "manager" | "editor") => request<TeamMember>(`/restaurants/${pointId}/members/${userId}`, "PATCH", { role });
export const removeMember = (pointId: string, userId: string) => request<void>(`/restaurants/${pointId}/members/${userId}`, "DELETE");
export const acceptInvite = (token: string) => request<TeamMember>("/invites/accept", "POST", { token });
