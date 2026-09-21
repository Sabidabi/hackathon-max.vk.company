import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { GuestItemDialog } from "../menu/GuestItemDialog";
import { displayPrice } from "../menu/configuration";
import { fetchPublicMenu, type MenuItem } from "../../api/menu";
import { SiteLayout } from "../site/SiteLayout";
import { fetchCurrentUser, loginWithMax } from "../../api/auth";
import { fetchFavorite, updateFavorite } from "../../api/notifications";
import { initializeMaxBridge } from "../../max/bridge";

const maxContext = initializeMaxBridge();

export function PublicMenu({ publicId }: { publicId: string }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<MenuItem | null>(null);
  const [search, setSearch] = useState("");
  const [onlyAvailable, setOnlyAvailable] = useState(true);
  const menu = useQuery({
    queryKey: ["public-menu", publicId],
    queryFn: () => fetchPublicMenu(publicId),
    retry: false,
  });
  const currentUser = useQuery({ queryKey: ["current-user"], queryFn: fetchCurrentUser, retry: false });
  const maxLogin = useMutation({
    mutationFn: loginWithMax,
    onSuccess: (user) => queryClient.setQueryData(["current-user"], user),
  });
  useEffect(() => {
    if (currentUser.isSuccess && currentUser.data === null && maxContext.initData && !maxLogin.isPending && !maxLogin.isSuccess) maxLogin.mutate(maxContext.initData);
  }, [currentUser.data, currentUser.isSuccess, maxLogin]);
  const favorite = useQuery({
    queryKey: ["favorite", publicId],
    queryFn: () => fetchFavorite(publicId),
    enabled: Boolean(currentUser.data),
  });
  const favoriteUpdate = useMutation({
    mutationFn: updateFavorite.bind(null, publicId),
    onSuccess: (result) => queryClient.setQueryData(["favorite", publicId], result),
  });
  const query = search.trim().toLocaleLowerCase("ru");
  const sections = useMemo(
    () =>
      (menu.data?.sections ?? [])
        .map((section) => ({
          ...section,
          items: section.items.filter((item) => {
            if (onlyAvailable && !item.is_available) return false;
            if (!query) return true;
            return `${item.name} ${item.description ?? ""} ${item.ingredients ?? ""}`
              .toLocaleLowerCase("ru")
              .includes(query);
          }),
        }))
        .filter((section) => section.items.length > 0),
    [menu.data?.sections, onlyAvailable, query],
  );

  if (menu.isPending) return <main className="public-shell public-state">Открываем меню…</main>;
  if (menu.isError) {
    return (
      <main className="public-shell public-state">
        <h1>Меню пока недоступно</h1>
        <p>{menu.error.message}</p>
      </main>
    );
  }

  const menuContent = (
    <>
      <div className="public-controls">
        <input
          type="search"
          value={search}
          placeholder="Найти блюдо"
          aria-label="Поиск по меню"
          onChange={(event) => setSearch(event.target.value)}
        />
        <label>
          <input
            type="checkbox"
            checked={onlyAvailable}
            onChange={(event) => setOnlyAvailable(event.target.checked)}
          />
          Только в наличии
        </label>
        {currentUser.data && favorite.data && <div className="favorite-actions"><button type="button" className={favorite.data.is_favorite ? "is-active" : ""} aria-label={favorite.data.is_favorite ? "Убрать из избранного" : "Добавить в избранное"} onClick={() => favoriteUpdate.mutate({ is_favorite: !favorite.data.is_favorite, notifications_enabled: false })}><Star size={17} fill={favorite.data.is_favorite ? "currentColor" : "none"} /></button>{favorite.data.is_favorite && <button type="button" className={favorite.data.notifications_enabled ? "is-active" : ""} aria-label={favorite.data.notifications_enabled ? "Отключить уведомления" : "Включить уведомления"} onClick={() => favoriteUpdate.mutate({ is_favorite: true, notifications_enabled: !favorite.data.notifications_enabled })}>{favorite.data.notifications_enabled ? <Bell size={17} /> : <BellOff size={17} />}</button>}</div>}
      </div>

      {menu.data.version === null ? (
        <p className="public-empty">Меню скоро появится.</p>
      ) : sections.length ? (
        <div className="public-sections">
          {sections.map((section) => (
            <section key={section.id}>
              <h2>{section.name}</h2>
              <div className="public-items">
                {section.items.map((item) => (
                  <article
                    key={item.id}
                    className={`${item.image_url ? "public-item--with-image" : ""} ${
                      item.is_available ? "" : "public-item--unavailable"
                    }`}
                  >
                    {item.image_url && (
                      <img
                        className="public-item-image"
                        src={item.image_url}
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                    )}
                    <div>
                      <h3>{item.name}</h3>
                      {item.description && <p>{item.description}</p>}
                      {item.weight_text && <small>{item.weight_text}</small>}
                      {!item.is_available && <small>Временно нет в наличии</small>}
                    </div>
                    <div className="guest-item-action"><strong>{displayPrice(item)}</strong>{item.is_available && <button className="guest-configure-button" onClick={() => setSelected(item)}>Подробнее</button>}</div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <p className="public-empty">По вашему запросу ничего не найдено.</p>
      )}
    </>
  );

  return (
    <main className="public-shell">
      {selected && <GuestItemDialog item={selected} publicId={publicId} onClose={() => setSelected(null)} />}
      <SiteLayout
        config={menu.data.site}
        restaurant={menu.data.restaurant}
        menuContent={menuContent}
      />
    </main>
  );
}
