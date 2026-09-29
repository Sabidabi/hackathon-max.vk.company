/** `detail` of an API error: a string, or an object with `message` (e.g. the structured
 * 409 `revision_conflict` of menu drafts and publication). */
export function errorDetail(payload: unknown): string | undefined {
  const detail = (payload as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object" && typeof (detail as { message?: unknown }).message === "string") {
    return (detail as { message: string }).message;
  }
  if (Array.isArray(detail) && detail.length && typeof (detail[0] as { msg?: unknown })?.msg === "string") {
    return String((detail[0] as { msg: string }).msg).replace(/^Value error, /, "");
  }
  return undefined;
}

/** Summary of what others changed (`MenuDiff` of the backend). */
export interface MenuChanges {
  added: { item_key: string; name: string; section: string }[];
  removed: { item_key: string; name: string; section: string }[];
  changed: { item_key: string; name: string; section: string; changes: { field: string; before: unknown; after: unknown }[] }[];
  sections_added: string[];
  sections_removed: string[];
  total_changes: number;
}

/** Structured 409 of a stale draft revision. */
export interface RevisionConflict {
  code: "revision_conflict";
  message: string;
  menu_id: string;
  current_revision: string;
  last_publication: { version: number; published_at: string; author: { id: string; display_name: string } | null } | null;
  seen_version: number | null;
  changes: MenuChanges | null;
}

/** HTTP error with the status and the raw `detail`, so screens can react to a conflict. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;
  constructor(message: string, status: number, detail: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

export function revisionConflict(error: unknown): RevisionConflict | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const detail = error.detail as Partial<RevisionConflict> | null;
  return detail && typeof detail === "object" && detail.code === "revision_conflict" ? (detail as RevisionConflict) : null;
}

export async function parseApiJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new ApiError(errorDetail(payload) ?? `${fallback}: ${response.status}`, response.status, (payload as { detail?: unknown } | null)?.detail);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
