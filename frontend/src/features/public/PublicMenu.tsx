import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, ChevronRight, Search, Star, Utensils } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { fetchCurrentUser, loginWithMax } from "../../api/auth";
import { fetchPublicMenu, type MenuItem } from "../../api/menu";
import { fetchFavorite, updateFavorite } from "../../api/notifications";
import { initializeMaxBridge } from "../../max/bridge";
import { GuestItemDialog } from "../menu/GuestItemDialog";
import { displayPrice } from "../menu/configuration";
import { SiteLayout } from "../site/SiteLayout";

const maxContext = initializeMaxBridge();

function sectionElementId(sectionId: string) {
  return `menu-section-${sectionId}`;
}

export function PublicMenu({ publicId }: { publicId: string }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<MenuItem | null>(null);
  const [search, setSearch] = useState("");
  const [onlyAvailable, setOnlyAvailable] = useState(true);
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const categoryRailRef = useRef<HTMLElement | null>(null);
  const menu = useQuery({
    queryKey: ["public-menu", publicId],
    queryFn: () => fetchPublicMenu(publicId),
    retry: false,
  });
  const currentUser = useQuery({
    queryKey: ["current-user"],
    queryFn: fetchCurrentUser,
    retry: false,
  });
  const maxLogin = useMutation({
    mutationFn: loginWithMax,
    onSuccess: (user) => queryClient.setQueryData(["current-user"], user),
  });

  useEffect(() => {
    if (
      currentUser.isSuccess
      && currentUser.data === null
      && maxContext.initData
      && !maxLogin.isPending
      && !maxLogin.isSuccess
    ) {
      maxLogin.mutate(maxContext.initData);
    }
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
  const sectionKey = sections.map((section) => section.id).join(":");

  useEffect(() => {
    if (!sections.length) {
      setActiveSectionId(null);
      return;
    }
    setActiveSectionId((current) =>
      current && sections.some((section) => section.id === current)
        ? current
        : sections[0].id,
    );
    if (!("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const firstVisible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
        if (firstVisible) {
          setActiveSectionId(firstVisible.target.getAttribute("data-section-id"));
        }
      },
      { rootMargin: "-150px 0px -55% 0px", threshold: [0, 0.05, 0.25] },
    );
    sections.forEach((section) => {
      const element = document.getElementById(sectionElementId(section.id));
      if (element) observer.observe(element);
    });
    return () => observer.disconnect();
  }, [sectionKey, sections]);

  useEffect(() => {
    if (!activeSectionId) return;
    categoryRailRef.current
      ?.querySelector<HTMLElement>(`[data-category-id="${activeSectionId}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [activeSectionId]);

  if (menu.isPending) return <main className="public-shell public-state">Открываем меню…</main>;
  if (menu.isError) {
    return (
      <main className="public-shell public-state">
        <h1>Меню пока недоступно</h1>
        <p>{menu.error.message}</p>
      </main>
    );
  }

  function scrollToSection(sectionId: string) {
    setActiveSectionId(sectionId);
    document.getElementById(sectionElementId(sectionId))?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  const menuContent = (
    <div className="mobile-menu-catalog">
      <div className="catalog-discovery">
        <label className="catalog-search">
          <Search size={18} />
          <input
            type="search"
            value={search}
            placeholder="Найти блюдо"
            aria-label="Поиск по меню"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className={`availability-filter${onlyAvailable ? " is-active" : ""}`}>
          <input
            type="checkbox"
            checked={onlyAvailable}
            onChange={(event) => setOnlyAvailable(event.target.checked)}
          />
          В наличии
        </label>
        {currentUser.data && favorite.data && (
          <div className="favorite-actions">
            <button
              type="button"
              className={favorite.data.is_favorite ? "is-active" : ""}
              aria-label={favorite.data.is_favorite ? "Убрать из избранного" : "Добавить в избранное"}
              onClick={() => favoriteUpdate.mutate({
                is_favorite: !favorite.data.is_favorite,
                notifications_enabled: false,
              })}
            >
              <Star size={19} fill={favorite.data.is_favorite ? "currentColor" : "none"} />
            </button>
            {favorite.data.is_favorite && (
              <button
                type="button"
                className={favorite.data.notifications_enabled ? "is-active" : ""}
                aria-label={favorite.data.notifications_enabled ? "Отключить уведомления" : "Включить уведомления"}
                onClick={() => favoriteUpdate.mutate({
                  is_favorite: true,
                  notifications_enabled: !favorite.data.notifications_enabled,
                })}
              >
                {favorite.data.notifications_enabled ? <Bell size={18} /> : <BellOff size={18} />}
              </button>
            )}
          </div>
        )}
      </div>

      {sections.length > 1 && (
        <nav className="menu-category-rail" aria-label="Категории меню" ref={categoryRailRef}>
          <div>
            {sections.map((section) => (
              <button
                type="button"
                key={section.id}
                data-category-id={section.id}
                aria-current={activeSectionId === section.id ? "true" : undefined}
                onClick={() => scrollToSection(section.id)}
              >
                {section.name}
              </button>
            ))}
          </div>
        </nav>
      )}

      {menu.data.version === null ? (
        <p className="public-empty">Меню скоро появится.</p>
      ) : sections.length ? (
        <div className="public-sections">
          {sections.map((section) => (
            <section
              key={section.id}
              id={sectionElementId(section.id)}
              data-section-id={section.id}
            >
              <header className="menu-section-heading">
                <h2>{section.name}</h2>
                <span>{section.items.length}</span>
              </header>
              <div className="public-items">
                {section.items.map((item, itemIndex) => {
                  const configurable = Boolean(
                    item.configuration?.variants.length
                    || item.configuration?.modifier_groups.length,
                  );
                  return (
                    <article
                      key={item.id}
                      className={item.is_available ? "" : "public-item--unavailable"}
                    >
                      <button
                        type="button"
                        className={`menu-card-button menu-card-tone--${itemIndex % 4}${item.image_url ? "" : " menu-card-button--no-image"}`}
                        disabled={!item.is_available}
                        aria-label={item.is_available ? `Открыть ${item.name}` : `${item.name} — временно нет`}
                        onClick={() => setSelected(item)}
                      >
                        <span className="menu-card-media">
                          {item.image_url ? (
                            <img src={item.image_url} alt={item.name} loading="lazy" decoding="async" />
                          ) : (
                            <span className="menu-card-placeholder"><Utensils size={23} /><i aria-hidden="true" /></span>
                          )}
                        </span>
                        <span className="menu-card-content">
                          <strong>{item.name}</strong>
                          {item.description && <span className="menu-card-description">{item.description}</span>}
                          <span className="menu-card-meta">
                            {item.weight_text && <small>{item.weight_text}</small>}
                            {configurable && <small>Есть выбор</small>}
                            {!item.is_available && <small className="unavailable-badge">Временно нет</small>}
                          </span>
                          <span className="menu-card-footer">
                            <b>{displayPrice(item)}</b>
                            <span aria-hidden="true"><ChevronRight size={17} /></span>
                          </span>
                        </span>
                      </button>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <p className="public-empty">По вашему запросу ничего не найдено.</p>
      )}
    </div>
  );

  return (
    <main className="public-shell">
      {selected && (
        <GuestItemDialog item={selected} publicId={publicId} onClose={() => setSelected(null)} />
      )}
      <SiteLayout
        config={menu.data.site}
        restaurant={menu.data.restaurant}
        menuContent={menuContent}
      />
    </main>
  );
}
