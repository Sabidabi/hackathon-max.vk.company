// Signed-in extras over a public menu.
// Kept outside the guest menu (features/guest plugs them in via session.ts and GuestMenu.tsx):
// the menu itself never waits for login and never depends on them.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";

import type { AuthUser } from "../../api/auth";
import { HOME_QUERY_KEY, recordRecentVisit } from "../../api/me";
import { listRestaurants } from "../../api/restaurants";

/**
 * True when the signed-in user administers the venue with this public id. Navigation hint only:
 * the list is the server's membership, and every cabinet request is checked again.
 */
export function useVenueAdmin(publicId: string, user: AuthUser | null | undefined): boolean {
  const managed = useQuery({
    queryKey: ["restaurants"],
    queryFn: listRestaurants,
    enabled: Boolean(user),
    retry: false,
  });
  return Boolean(user && managed.data?.some((point) => point.public_id === publicId));
}

/** Home «Недавние»: remembers the opened menu once per venue for a signed-in user. */
export function useRecordRecentVisit(publicId: string, user: AuthUser | null | undefined, published: boolean): void {
  const queryClient = useQueryClient();
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (!user || !published || recorded.current === publicId) return;
    recorded.current = publicId;
    recordRecentVisit(publicId)
      .then(() => queryClient.invalidateQueries({ queryKey: HOME_QUERY_KEY }))
      .catch(() => undefined); // history is a courtesy; never disturb the menu
  }, [publicId, published, queryClient, user]);
}

/**
 * Cabinet path for «Редактировать». With an item it carries section and item names
 * (`?section=&item=`): draft and published rows have different IDs.
 */
export function venueEditPath(publicId: string, item?: { name: string; section?: string | null } | null): string {
  if (!item) return `/manage/${publicId}`;
  const params = new URLSearchParams(item.section ? { section: item.section, item: item.name } : { item: item.name });
  return `/manage/${publicId}?${params}`;
}

/** Floating «Редактировать» over the guest menu, for admins of this venue only. */
export function VenueEditFab({ publicId }: { publicId: string }) {
  return (
    <Link className="s-button s-button--primary guest-edit-fab" to={venueEditPath(publicId)}>
      <Pencil size={20} aria-hidden="true" />
      <span className="s-button__label">Редактировать</span>
    </Link>
  );
}
