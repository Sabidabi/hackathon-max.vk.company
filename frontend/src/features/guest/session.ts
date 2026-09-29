import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { fetchAuthBootstrap, fetchCurrentUser, loginWithMax } from "../../api/auth";
import { fetchFavorite, updateFavorite } from "../../api/notifications";
import { deviceStorage } from "../../max";
import type { MaxContext } from "../../max";
import { useRecordRecentVisit, useVenueAdmin } from "../auth/guestMode";

/**
 * Product events of the guest menu (P1-DOC-10 dictionary). `src/analytics` listens to
 * `sinitsa:event` on window and sends batches; props carry no personal data.
 */
export type GuestEventName =
  | "app_open" | "menu_view" | "category_view" | "search" | "search_empty" | "item_view"
  | "item_add" | "item_remove" | "choice_shown" | "favorite_add" | "share_menu"
  | "ai_ask" | "ai_answer_click";

export function trackGuestEvent(name: GuestEventName, props: Record<string, unknown> = {}): void {
  try {
    window.dispatchEvent(new CustomEvent("sinitsa:event", { detail: { ...props, name } }));
  } catch {
    // Events are best effort.
  }
}

/**
 * Signed-in state of the guest: inside MAX the signed initData creates a session (the server
 * checks it); in a browser the guest stays anonymous. Records the visit for Home «Недавние».
 */
export function useGuestSession(publicId: string, maxContext: MaxContext, published: boolean) {
  const queryClient = useQueryClient();
  const loginStarted = useRef(false);
  const currentUser = useQuery({ queryKey: ["current-user"], queryFn: fetchCurrentUser, retry: false, staleTime: 60_000 });
  const login = useMutation({
    mutationFn: loginWithMax,
    onSuccess: (user) => queryClient.setQueryData(["current-user"], user),
  });
  const mutateLogin = login.mutate;

  useEffect(() => {
    if (currentUser.isSuccess && currentUser.data === null && maxContext.initData && !loginStarted.current) {
      loginStarted.current = true;
      mutateLogin(maxContext.initData);
    }
  }, [currentUser.data, currentUser.isSuccess, maxContext.initData, mutateLogin]);

  const signedIn = Boolean(currentUser.data);

  // Shared signed-in extras (P1-PLAN-4): Home «Недавние» and «Редактировать» for venue admins.
  useRecordRecentVisit(publicId, currentUser.data, published);
  const isAdmin = useVenueAdmin(publicId, currentUser.data);

  const favorite = useQuery({
    queryKey: ["favorite", publicId],
    queryFn: () => fetchFavorite(publicId),
    enabled: signedIn,
    retry: false,
  });
  const favoriteUpdate = useMutation({
    mutationFn: (next: { is_favorite: boolean; notifications_enabled: boolean }) => updateFavorite(publicId, {
      is_favorite: next.is_favorite,
      // Notifications only with an explicit opt-in and only for a favourite venue.
      notifications_enabled: next.is_favorite && next.notifications_enabled,
    }),
    onSuccess: (result) => queryClient.setQueryData(["favorite", publicId], result),
  });

  const bootstrap = useQuery({ queryKey: ["auth-bootstrap"], queryFn: fetchAuthBootstrap, retry: false, staleTime: 5 * 60_000 });

  return {
    signedIn,
    isAdmin,
    venueFavorite: favorite.data?.is_favorite ?? false,
    venueFavoriteBusy: favoriteUpdate.isPending,
    toggleVenueFavorite: () => favoriteUpdate.mutate({
      is_favorite: !(favorite.data?.is_favorite ?? false),
      notifications_enabled: Boolean(favorite.data?.notifications_enabled),
    }),
    venueNotifications: Boolean(favorite.data?.is_favorite && favorite.data?.notifications_enabled),
    toggleVenueNotifications: () => favoriteUpdate.mutate({
      is_favorite: true,
      notifications_enabled: !favorite.data?.notifications_enabled,
    }),
    launchUrl: bootstrap.data?.max_launch_url ?? null,
  };
}

const favoritesKey = (publicId: string) => `sinitsa.guest.favorites.${publicId}`;

/**
 * ♡ positions of a point. Kept in MAX device storage (per account and device) by item key or
 * id; a server list for Home «Ваше любимое» across devices is a separate backend task.
 */
export function useItemFavorites(publicId: string, enabled: boolean) {
  const [ids, setIds] = useState<string[]>([]);
  const loaded = useRef(false);

  useEffect(() => {
    let active = true;
    loaded.current = false;
    if (!enabled) {
      setIds([]);
      return;
    }
    void deviceStorage.getItem(favoritesKey(publicId)).then((raw) => {
      if (!active) return;
      try {
        const parsed = JSON.parse(raw ?? "[]") as unknown;
        setIds(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string").slice(0, 200) : []);
      } catch {
        setIds([]);
      }
      loaded.current = true;
    });
    return () => {
      active = false;
    };
  }, [enabled, publicId]);

  const toggle = useCallback((key: string) => {
    setIds((current) => {
      const next = current.includes(key) ? current.filter((value) => value !== key) : [...current, key];
      void deviceStorage.setItem(favoritesKey(publicId), JSON.stringify(next));
      return next;
    });
  }, [publicId]);

  return { ids, toggle };
}

/** Favourite key of a position: stable `item_key` when the server sends it, else the id. */
export function favoriteKey(item: { id: string; item_key?: string | null }): string {
  return item.item_key ?? item.id;
}
