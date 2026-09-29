import { useQuery } from "@tanstack/react-query";
import { Bell, BellOff, Check, Clock3, Heart, MapPin, Minus, Plus, Search, SearchX, Share2, X } from "lucide-react";
import { Fragment, useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";

import { ButtonLink, Chip, EmptyState, IconButton, showToast } from "../../design";
import { maxDeepLink } from "../../design/screens";
import { haptics, share, type MaxContext } from "../../max";
import { VenueEditFab, venueEditPath } from "../auth/guestMode";
import { fetchGuestMenu, formatMoney, type AskPick, type GuestItem, type GuestMenu as GuestMenuData, type GuestMenuTab } from "./api";
import { AskButton, AskSheet } from "./AskSheet";
import { CashierView, ChoiceBar, ChoiceSheet } from "./ChoicePanel";
import { GuestStateScreen } from "./GuestStates";
import { canQuickAdd, ItemSheet, quickLine } from "./ItemSheet";
import { bumpBar, easeSpring, flyToBar, heartBurst, prefersReducedMotion, slideIndicator, toRect, type Rect } from "./motion";
import { MotionSheet, type SheetOrigin } from "./MotionSheet";
import { searchItems } from "./search";
import { favoriteKey, trackGuestEvent, useGuestSession, useItemFavorites } from "./session";
import { themeVariables, tileAttributes } from "./theme";
import { useChoice } from "./useChoice";
import "./guest.css";
import "./soft-tiles.css";
import "./soft-sheet.css";
import { WriteToPointButton } from "../notifications/GuestButtons";

interface Selected {
  item: GuestItem;
  sectionName: string;
  linked: boolean;
  origin: SheetOrigin | null;
}

/**
 * A point may show several menus at once («Основное» and «Завтраки» by hours). Guests get one
 * list: the sections of every active menu, no tab bar on top.
 */
function mergeTabs(tabs: GuestMenuTab[]): GuestMenuTab[] {
  if (tabs.length < 2) return tabs;
  return [{ ...tabs[0], title: "Меню", sections: tabs.flatMap((candidate) => candidate.sections) }];
}

function sectionDomId(tabId: string, sectionId: string) {
  return `g-section-${tabId}-${sectionId}`;
}

/** A deep link carries the full item id or a short hex prefix of it (`r_<id>_i_<item>`). */
export function matchesLinkedItem(item: { id: string; item_key?: string | null }, linkedId: string): boolean {
  if (item.id === linkedId || item.item_key === linkedId) return true;
  const short = linkedId.toLowerCase().replace(/-/g, "");
  return short.length >= 8 && item.id.replace(/-/g, "").toLowerCase().startsWith(short);
}

/** «от 190 ₽» for items with several sizes (cheapest available size), else the price. */
export function fromPrice(item: GuestItem): string {
  const prices = item.configuration?.variants.filter((variant) => variant.is_available).map((variant) => variant.price_minor) ?? [];
  const amount = prices.length ? Math.min(...prices) : item.price_minor;
  return `${prices.length > 1 ? "от " : ""}${formatMoney(amount)}`;
}

function Highlighted({ text, ranges }: { text: string; ranges?: Array<[number, number]> }) {
  if (!ranges?.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], index) => {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(<mark key={index}>{text.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

type OpenItem = (item: GuestItem, sectionName: string, origin?: HTMLElement | null) => void;
type QuickAdd = (item: GuestItem, sectionName: string, from: Rect) => void;
type QuickRemove = (item: GuestItem) => void;

/** First letter(s) of a position without a photo: a soft medallion instead of a grey stub. */
function monogram(name: string): string {
  const letters = name.trim().match(/[\p{L}\p{N}]/gu) ?? [];
  return (letters[0] ?? "•").toUpperCase();
}

/** First build of the catalog: up to 8 cards cascade in once (P1-DOC-18), never on scroll. */
const CASCADE_LIMIT = 8;

function ItemCard({ item, sectionName, highlights, favorite, inChoice, onOpen, onQuickAdd, onQuickRemove, enterIndex }: {
  item: GuestItem;
  /** Total quantity of this position in «Мой выбор» over all sizes and add-on variants. */
  inChoice: number;
  sectionName: string;
  highlights?: Array<[number, number]>;
  favorite: boolean;
  onOpen: OpenItem;
  onQuickAdd: QuickAdd;
  onQuickRemove: QuickRemove;
  enterIndex?: number;
}) {
  const mediaRef = useRef<HTMLSpanElement>(null);
  const detailsId = useId();
  const withPhoto = Boolean(item.image_url);
  const quick = canQuickAdd(item);
  return (
    <article
      className={`g-card${withPhoto ? " g-card--photo" : " g-card--row"}${item.is_available ? "" : " g-card--off"}${enterIndex !== undefined ? " g-card--enter" : ""}`}
      style={enterIndex !== undefined ? ({ "--g-i": enterIndex } as CSSProperties) : undefined}
    >
      <button
        type="button"
        className="g-card__open"
        aria-label={item.is_available ? `Открыть ${item.name}` : `${item.name} — нет в наличии`}
        aria-describedby={detailsId}
        onClick={() => onOpen(item, sectionName, mediaRef.current)}
      >
        {withPhoto ? (
          <span className="g-card__media" ref={mediaRef}>
            <img src={item.image_url!} alt="" loading="lazy" decoding="async" />
          </span>
        ) : (
          <span className="g-card__mono" aria-hidden="true">{monogram(item.name)}</span>
        )}
        <span className="g-card__body" id={detailsId}>
          <span className="g-card__name">
            <Highlighted text={item.name} ranges={highlights} />
            {favorite && <Heart className="g-card__fav" size={14} fill="currentColor" aria-label="В любимом" />}
          </span>
          {item.description && <span className="g-card__desc">{item.description}</span>}
          <span className="g-card__meta">
            {item.is_available
              ? <><b className="g-card__price">{fromPrice(item)}</b>{item.weight_text && <small className="g-card__weight">{item.weight_text}</small>}</>
              : <span className="g-badge g-badge--muted">Нет в наличии</span>}
          </span>
        </span>
      </button>
      {item.is_available && inChoice > 0 && quick && (
        <div className="g-stepper" role="group" aria-label={`${item.name}: в выборе ${inChoice}`}>
          <button type="button" className="g-stepper__btn" aria-label={`Убрать одну: ${item.name}`} onClick={() => onQuickRemove(item)}>
            <Minus size={18} aria-hidden="true" />
          </button>
          <b key={inChoice} className="g-stepper__qty" aria-live="polite">{inChoice}</b>
          <button
            type="button"
            className="g-stepper__btn"
            aria-label={`Добавить ещё: ${item.name}`}
            onClick={(event) => onQuickAdd(item, sectionName, toRect(event.currentTarget.getBoundingClientRect()))}
          >
            <Plus size={18} aria-hidden="true" />
          </button>
        </div>
      )}
      {item.is_available && !(inChoice > 0 && quick) && (
        <button
          type="button"
          className="g-card__add"
          data-state={inChoice > 0 ? "in" : "out"}
          aria-label={inChoice > 0
            ? `${item.name}: в выборе ${inChoice}. Изменить`
            : quick ? `Добавить ${item.name} в мой выбор` : `Выбрать параметры: ${item.name}`}
          onClick={(event) => {
            if (!quick) {
              onOpen(item, sectionName, mediaRef.current);
              return;
            }
            onQuickAdd(item, sectionName, toRect(event.currentTarget.getBoundingClientRect()));
          }}
        >
          {inChoice > 0 ? <Check size={20} strokeWidth={2.5} aria-hidden="true" /> : <Plus size={20} strokeWidth={2.5} aria-hidden="true" />}
          <span className="g-card__add-label" aria-hidden="true">{inChoice > 0 ? "В выборе" : quick ? "Добавить" : "Выбрать"}</span>
          {inChoice > 1 && <b key={inChoice} className="g-card__count" aria-hidden="true">{inChoice}</b>}
        </button>
      )}
    </article>
  );
}

function ItemGrid({ items, sectionName, favorites, counts, onOpen, onQuickAdd, onQuickRemove, highlights, cascade }: {
  items: GuestItem[];
  sectionName: string | ((item: GuestItem) => string);
  favorites: Set<string>;
  counts: Map<string, number>;
  onOpen: OpenItem;
  onQuickAdd: QuickAdd;
  onQuickRemove: QuickRemove;
  highlights?: Map<string, Array<[number, number]>>;
  /** Hands out cascade indices during the first build; undefined afterwards. */
  cascade?: () => number | undefined;
}) {
  const nameOf = (item: GuestItem) => (typeof sectionName === "function" ? sectionName(item) : sectionName);
  const card = (item: GuestItem) => (
    <ItemCard
      key={item.id}
      item={item}
      sectionName={nameOf(item)}
      highlights={highlights?.get(item.id)}
      favorite={favorites.has(favoriteKey(item))}
      inChoice={counts.get(item.id) ?? 0}
      onOpen={onOpen}
      onQuickAdd={onQuickAdd}
      onQuickRemove={onQuickRemove}
      enterIndex={cascade?.()}
    />
  );
  return (
    // One grid in the owner's order: a photo tile takes a column, a text-only tile the full row.
    <div className="g-grid">{items.map(card)}</div>
  );
}

function useStickyHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setHeight(element.getBoundingClientRect().height);
    update();
    if (!("ResizeObserver" in window)) return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

/** Venue theme on the menu root and on <body> (sheets and the cashier view are portalled). */
function useBodyTheme(variables: Record<string, string>) {
  useEffect(() => {
    const body = document.body;
    const entries = Object.entries(variables);
    const previous = entries.map(([name]) => [name, body.style.getPropertyValue(name)] as const);
    entries.forEach(([name, value]) => body.style.setProperty(name, value));
    body.classList.add("g-body");
    return () => {
      previous.forEach(([name, value]) => (value ? body.style.setProperty(name, value) : body.style.removeProperty(name)));
      body.classList.remove("g-body");
    };
  }, [variables]);
}

export interface GuestSurfaceProps {
  publicId: string;
  /** `/r/:publicId/i/:itemId`: open this item's card once the menu is loaded. */
  itemId?: string | null;
  maxContext: MaxContext;
  /** Leave the item address (`/r/:id/i/:item` → `/r/:id`) after its card closes. */
  onLinkedItemClose?: () => void;
}

/** Guest menu 2.0 (P1-PLAN-6): the whole `/r/:publicId` screen. */
export function GuestSurface({ publicId, itemId = null, maxContext, onLinkedItemClose }: GuestSurfaceProps) {
  const menu = useQuery({
    queryKey: ["guest-menu", publicId],
    queryFn: ({ signal }) => fetchGuestMenu(publicId, signal),
    retry: false,
  });

  if (menu.isPending) return <GuestStateScreen kind="loading" />;
  if (menu.isError) {
    return <GuestStateScreen kind="error" error={menu.error} retrying={menu.isFetching} onRetry={() => void menu.refetch()} />;
  }
  return <GuestMenuScreen key={publicId} data={menu.data} publicId={publicId} itemId={itemId} maxContext={maxContext} onLinkedItemClose={onLinkedItemClose} />;
}

function GuestMenuScreen({ data, publicId, itemId, maxContext, onLinkedItemClose }: GuestSurfaceProps & { data: GuestMenuData }) {
  const { restaurant, site } = data;
  const tabs = useMemo(() => mergeTabs(data.tabs), [data.tabs]);
  // Analytics keep the menu each position really belongs to.
  const menuByItem = useMemo(() => new Map(data.tabs.flatMap((candidate) => candidate.sections.flatMap((section) =>
    section.items.map((item): [string, string] => [item.id, candidate.menu_id])))), [data.tabs]);
  const variables = useMemo<Record<string, string>>(() => ({ ...themeVariables(site), "--g-spring": easeSpring() }), [site]);
  useBodyTheme(variables);
  const rootStyle = useMemo(() => {
    const { "color-scheme": colorScheme, ...custom } = variables;
    return { ...custom, colorScheme } as CSSProperties;
  }, [variables]);

  // 200 from the server means something is published at this point (possibly outside its hours).
  const session = useGuestSession(publicId, maxContext, tabs.length > 0 || data.outsideHours);
  const inMax = maxContext.available;
  const favorites = useItemFavorites(publicId, inMax);
  const favoriteSet = useMemo(() => new Set(favorites.ids), [favorites.ids]);
  const choice = useChoice(publicId, tabs);

  // Quantity per catalog item over every line of it (any size / add-ons), by id or item_key.
  const counts = useMemo(() => {
    const byRef = new Map<string, number>();
    choice.lines.forEach((line) => {
      byRef.set(line.itemId, (byRef.get(line.itemId) ?? 0) + line.qty);
      if (line.itemKey) byRef.set(`key:${line.itemKey}`, (byRef.get(`key:${line.itemKey}`) ?? 0) + line.qty);
    });
    const result = new Map<string, number>();
    tabs.forEach((candidate) => candidate.sections.forEach((section) => section.items.forEach((item) => {
      const total = Math.max(byRef.get(item.id) ?? 0, item.item_key ? byRef.get(`key:${item.item_key}`) ?? 0 : 0);
      if (total > 0) result.set(item.id, total);
    })));
    return result;
  }, [choice.lines, tabs]);

  const [tabId, setTabId] = useState(() => tabs[0]?.menu_id ?? "");
  const tab: GuestMenuTab | undefined = tabs.find((candidate) => candidate.menu_id === tabId) ?? tabs[0];
  const sections = useMemo(() => (tab?.sections ?? []).filter((section) => section.items.length > 0), [tab]);
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim());
  const [selected, setSelected] = useState<Selected | null>(null);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [cashierOpen, setCashierOpen] = useState(false);
  const [openInMax, setOpenInMax] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const stickyHeight = useStickyHeight(stickyRef);
  const linkedHandled = useRef<string | null>(null);
  // A tapped category stays active while the page scrolls to it (and at the end of a short page).
  const chipLock = useRef(0);
  const railIndicator = useRef<HTMLSpanElement>(null);
  const railPlaced = useRef(false);
  const [cashierFrom, setCashierFrom] = useState<{ x: number; y: number } | null>(null);
  // First build of the catalog cascades once; later renders (scroll, search, tabs) do not.
  const [cascading, setCascading] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setCascading(false), 900);
    return () => window.clearTimeout(timer);
  }, []);

  // Everything searchable across all tabs, with the section each item lives in.
  const catalog = useMemo(() => tabs.flatMap((candidate) => candidate.sections.flatMap((section) =>
    section.items.map((item) => ({ item, sectionName: section.name, tabId: candidate.menu_id })))), [tabs]);
  const sectionOf = useMemo(() => new Map(catalog.map((entry) => [entry.item.id, entry.sectionName])), [catalog]);
  const hits = useMemo(() => (query ? searchItems(catalog.map((entry) => entry.item), query) : []), [catalog, query]);

  // P1-TASK-18 / P1-PLAN-4 [decision]: an item address opens its card; an unknown item says so
  // and returns to the menu.
  useEffect(() => {
    if (!itemId || linkedHandled.current === itemId) return;
    linkedHandled.current = itemId;
    const entry = catalog.find(({ item }) => matchesLinkedItem(item, itemId));
    if (!entry) {
      showToast("Позиция не найдена");
      onLinkedItemClose?.();
      return;
    }
    setTabId(entry.tabId);
    setSelected({ item: entry.item, sectionName: entry.sectionName, linked: true, origin: null });
  }, [catalog, itemId, onLinkedItemClose]);

  // The category rail follows the scroll (P1-DOC-6 «Липкие категории»).
  const sectionKey = sections.map((section) => section.id).join(":");
  useEffect(() => {
    if (query || !sections.length || !tab) {
      setActiveSection(null);
      return;
    }
    setActiveSection((current) => (current && sections.some((section) => section.id === current) ? current : sections[0].id));
    if (!("IntersectionObserver" in window)) return;
    // Entries report only the sections that changed, so keep the state of all of them and
    // take the topmost visible one.
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const id = entry.target.getAttribute("data-section-id");
        if (!id) return;
        if (entry.isIntersecting) visible.set(id, entry.boundingClientRect.top);
        else visible.delete(id);
      });
      if (Date.now() < chipLock.current) return;
      const order = sections.map((section) => section.id);
      const first = order.find((id) => visible.has(id));
      if (first) setActiveSection(first);
    }, { rootMargin: `-${Math.round(stickyHeight) + 8}px 0px -55% 0px`, threshold: [0, 0.05, 0.25] });
    sections.forEach((section) => {
      const element = document.getElementById(sectionDomId(tab.menu_id, section.id));
      if (element) observer.observe(element);
    });
    return () => observer.disconnect();
  }, [sectionKey, tab?.menu_id, query, Math.round(stickyHeight / 8)]);

  // The active chip background slides to the new category (FLIP), P1-DOC-18.
  useLayoutEffect(() => {
    const rail = railRef.current;
    const chip = activeSection ? rail?.querySelector<HTMLElement>(`[data-category-id="${activeSection}"]`) ?? null : null;
    slideIndicator(railIndicator.current, rail ?? null, chip, railPlaced.current);
    railPlaced.current = Boolean(chip);
  }, [activeSection, sectionKey]);

  useEffect(() => {
    if (!activeSection) return;
    const chip = railRef.current?.querySelector<HTMLElement>(`[data-category-id="${activeSection}"]`);
    const rail = railRef.current;
    if (!chip || !rail) return;
    const left = chip.offsetLeft - (rail.clientWidth - chip.clientWidth) / 2;
    rail.scrollTo({ left, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [activeSection]);

  const scrollToSection = useCallback((sectionId: string) => {
    if (!tab) return;
    trackGuestEvent("category_view", { public_id: publicId, menu_id: tab.menu_id, section_id: sectionId });
    chipLock.current = Date.now() + 900;
    setActiveSection(sectionId);
    const element = document.getElementById(sectionDomId(tab.menu_id, sectionId));
    if (!element) return;
    const top = element.getBoundingClientRect().top + window.scrollY - stickyHeight - 8;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
  }, [publicId, stickyHeight, tab]);

  // Analytics (P1-TASK-34): a search is reported once the guest stops typing — length and
  // count only; the phrase goes with `search_empty` to the empty-search aggregate alone.
  const hitCount = hits.length;
  useEffect(() => {
    if (!query) return;
    const timer = window.setTimeout(() => {
      trackGuestEvent("search", { public_id: publicId, query_len: query.length, results: hitCount });
      if (!hitCount) trackGuestEvent("search_empty", { public_id: publicId, query, query_len: query.length });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [hitCount, publicId, query]);

  const menuId = tab?.menu_id;
  useEffect(() => {
    trackGuestEvent("app_open", { public_id: publicId });
  }, [publicId]);
  useEffect(() => {
    if (menuId) trackGuestEvent("menu_view", { public_id: publicId, menu_id: menuId });
  }, [menuId, publicId]);

  const openItem = useCallback((item: GuestItem, sectionName: string, origin?: HTMLElement | null) => {
    haptics.selection();
    trackGuestEvent("item_view", {
      public_id: publicId, menu_id: menuByItem.get(item.id) ?? menuId, item_key: item.item_key ?? null, item_name: item.name,
      section_name: sectionName, available: item.is_available,
    });
    setSelected({ item, sectionName, linked: false, origin: origin ? { element: origin, image: item.image_url } : null });
  }, [menuByItem, menuId, publicId]);

  const selectedRef = useRef<Selected | null>(null);
  selectedRef.current = selected;
  const closeItem = useCallback(() => {
    const wasLinked = selectedRef.current?.linked;
    setSelected(null);
    if (wasLinked) onLinkedItemClose?.();
  }, [onLinkedItemClose]);

  // «В мой выбор»: haptics at once, then the thumbnail flies to the bar (mounted by now) and
  // the bar bumps (P1-DOC-18). The bar and total are already updated — motion never waits.
  const added = useCallback((item: GuestItem, from: Rect | null) => {
    haptics.notify("success");
    trackGuestEvent("item_add", { public_id: publicId, menu_id: menuByItem.get(item.id) ?? menuId, item_key: item.item_key ?? null, item_name: item.name });
    const accent = getComputedStyle(document.body).getPropertyValue("--sinitsa-blue").trim() || "currentColor";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!from) {
        bumpBar();
        return;
      }
      void flyToBar(from, item.image_url, accent).then(bumpBar);
    }));
  }, [menuId, publicId]);

  const quickAdd = useCallback((item: GuestItem, sectionName: string, from: Rect) => {
    choice.add(quickLine(item, sectionName));
    added(item, from);
  }, [added, choice]);

  const quickRemove = useCallback((item: GuestItem) => {
    const lines = choice.lines.filter((line) => line.itemId === item.id || (item.item_key && line.itemKey === item.item_key));
    const line = lines[lines.length - 1];
    if (!line) return;
    haptics.selection();
    if (line.qty > 1) {
      choice.setQty(line.lineId, line.qty - 1);
      return;
    }
    const index = choice.lines.findIndex((entry) => entry.lineId === line.lineId);
    trackGuestEvent("item_remove", { public_id: publicId });
    choice.remove(line.lineId);
    showToast(`${line.name} убрано из выбора`, { action: { label: "Отменить", onClick: () => choice.restore(line, index) } });
  }, [choice, publicId]);

  /** Returns true when the item has just become a favourite (the ♡ bursts). */
  const toggleItemFavorite = useCallback((item: GuestItem) => {
    if (!inMax) {
      setOpenInMax(true);
      return false;
    }
    haptics.selection();
    const key = favoriteKey(item);
    const willBeFavorite = !favorites.ids.includes(key);
    favorites.toggle(key);
    if (willBeFavorite) trackGuestEvent("favorite_add", { public_id: publicId, item_key: item.item_key ?? null, item_name: item.name });
    return willBeFavorite;
  }, [favorites, inMax, publicId]);

  const toggleVenueFavorite = (target: HTMLElement) => {
    if (!inMax || !session.signedIn) {
      setOpenInMax(true);
      return;
    }
    haptics.selection();
    if (!session.venueFavorite) heartBurst(target, getComputedStyle(target).color);
    session.toggleVenueFavorite();
  };

  const startPayload = `r_${publicId}`;
  const shareMenu = () => {
    const link = maxDeepLink(session.launchUrl, startPayload) ?? `${window.location.origin}/r/${encodeURIComponent(publicId)}`;
    trackGuestEvent("share_menu", { public_id: publicId });
    void share({ text: `Меню «${restaurant.name}»`, link });
  };

  const closeChoice = useCallback(() => {
    setChoiceOpen(false);
    choice.acknowledge();
  }, [choice]);
  const showAtCashier = useCallback((from: { x: number; y: number }) => {
    setCashierFrom(from);
    setChoiceOpen(false);
    choice.acknowledge();
    setCashierOpen(true);
    trackGuestEvent("choice_shown", { public_id: publicId, items: choice.lines.length });
  }, [choice, publicId]);
  const { remove: removeLine, restore: restoreLine, lines: choiceLines } = choice;
  const removeFromChoice = useCallback((lineId: string) => {
    const index = choiceLines.findIndex((line) => line.lineId === lineId);
    const line = choiceLines[index];
    trackGuestEvent("item_remove", { public_id: publicId });
    removeLine(lineId);
    if (!line) return;
    haptics.selection();
    showToast(`${line.name} убрано из выбора`, { action: { label: "Отменить", onClick: () => restoreLine(line, index) } });
  }, [choiceLines, publicId, removeLine, restoreLine]);
  const closeCashier = useCallback(() => {
    setCashierOpen(false);
    setChoiceOpen(true);
  }, []);

  const favoriteItems = useMemo(
    () => (inMax ? catalog.filter(({ item }) => favoriteSet.has(favoriteKey(item))) : []),
    [catalog, favoriteSet, inMax],
  );

  const coverStyle = site.cover_url ? ({ "--g-cover": `url("${site.cover_url.replace(/"/g, "%22")}")` } as CSSProperties) : undefined;
  const title = restaurant.venue_name && restaurant.venue_name !== restaurant.name ? restaurant.venue_name : restaurant.name;
  const subtitle = restaurant.venue_name && restaurant.venue_name !== restaurant.name ? restaurant.name : null;

  let cascadeCount = 0;
  const cascadeNext = cascading ? () => (cascadeCount < CASCADE_LIMIT ? cascadeCount++ : undefined) : undefined;

  return (
    <div className={`g-root g-root--enter g-template--${site.template}`} style={rootStyle} {...tileAttributes(site)}>
      <header className={`g-cover${site.cover_url ? " g-cover--image" : ""}`} style={coverStyle}>
        <div className="g-cover__row">
          {site.logo_url && <img className="g-cover__logo" src={site.logo_url} alt="" width={48} height={48} />}
          <div className="g-cover__text">
            <h1 className="g-cover__title">{title}</h1>
            {restaurant.is_demo && <span className="g-cover__demo" data-testid="demo-badge">Демо</span>}
            {subtitle && <p className="g-cover__point">{subtitle}</p>}
          </div>
          <div className="g-cover__actions">
            <IconButton
              variant="tonal"
              aria-label={session.venueFavorite ? "Убрать заведение из избранного" : "Заведение в избранное"}
              aria-pressed={session.venueFavorite}
              className={session.venueFavorite ? "g-heart g-heart--on" : "g-heart"}
              disabled={session.venueFavoriteBusy}
              icon={<Heart size={20} fill={session.venueFavorite ? "currentColor" : "none"} />}
              onClick={(event) => toggleVenueFavorite(event.currentTarget)}
            />
            {session.venueFavorite && (
              <IconButton
                variant="tonal"
                aria-label={session.venueNotifications ? "Отключить уведомления" : "Включить уведомления"}
                aria-pressed={session.venueNotifications}
                disabled={session.venueFavoriteBusy}
                icon={session.venueNotifications ? <Bell size={20} /> : <BellOff size={20} />}
                onClick={session.toggleVenueNotifications}
              />
            )}
            <WriteToPointButton publicId={publicId} />
            <IconButton variant="tonal" aria-label="Поделиться меню" icon={<Share2 size={20} />} onClick={shareMenu} />
          </div>
        </div>
        {(restaurant.address || site.hours) && (
          <p className="g-cover__meta">
            {restaurant.address && <span><MapPin size={14} aria-hidden="true" />{restaurant.address}</span>}
            {site.hours && <span><Clock3 size={14} aria-hidden="true" />{site.hours}</span>}
          </p>
        )}
        {(site.tagline || restaurant.description) && <p className="g-cover__tagline">{site.tagline || restaurant.description}</p>}
      </header>

      {!tabs.length ? (
        <main className="g-main">
          {data.outsideHours ? (
            <EmptyState icon={<Clock3 size={28} />} title="Сейчас меню не показывается">
              {site.hours ? `Часы работы: ${site.hours}.` : "Загляните чуть позже."}
            </EmptyState>
          ) : (
            <EmptyState icon={<Clock3 size={28} />} title="Меню ещё не опубликовано">
              Заведение готовит меню. Загляните чуть позже.
            </EmptyState>
          )}
        </main>
      ) : (
        <>
          <div className="g-search">
            <label className="g-search__field">
              <Search size={18} aria-hidden="true" />
              <input
                type="search"
                value={search}
                placeholder="Капучино, круассан…"
                aria-label="Поиск по меню"
                enterKeyHint="search"
                onChange={(event) => setSearch(event.target.value)}
              />
              {search && (
                <button type="button" className="g-search__clear" aria-label="Очистить поиск" onClick={() => setSearch("")}>
                  <X size={18} aria-hidden="true" />
                </button>
              )}
            </label>
            {catalog.some(({ item }) => item.is_available) && <AskButton onOpen={() => setAskOpen(true)} />}
          </div>

          <div className="g-sticky" ref={stickyRef}>
            {!query && sections.length > 1 && (
              <nav className="g-rail" aria-label="Категории меню" ref={railRef}>
                <span className="g-indicator g-rail__indicator" ref={railIndicator} aria-hidden="true" />
                {sections.map((section) => (
                  <Chip
                    key={section.id}
                    selected={activeSection === section.id}
                    data-category-id={section.id}
                    aria-current={activeSection === section.id ? "true" : undefined}
                    onClick={() => scrollToSection(section.id)}
                  >
                    {section.name}
                  </Chip>
                ))}
              </nav>
            )}
          </div>

          <main className="g-main">
            {query ? (
              hits.length ? (
                <section className="g-section" aria-label="Результаты поиска">
                  <header className="g-section__head">
                    <h2>Нашли</h2>
                    <span>{hits.length}</span>
                  </header>
                  <ItemGrid
                    items={hits.map((hit) => hit.item)}
                    sectionName={(item) => sectionOf.get(item.id) ?? ""}
                    favorites={favoriteSet}
                    counts={counts}
                    highlights={new Map(hits.map((hit) => [hit.item.id, hit.highlights]))}
                    onOpen={openItem}
                    onQuickAdd={quickAdd}
                    onQuickRemove={quickRemove}
                  />
                </section>
              ) : (
                <section className="g-empty-search">
                  <EmptyState icon={<SearchX size={28} />} title="Ничего не нашли">
                    Проверьте написание или посмотрите разделы меню.
                  </EmptyState>
                  <div className="g-empty-search__chips">
                    {sections.slice(0, 6).map((section) => (
                      <Chip
                        key={section.id}
                        selected={false}
                        onClick={() => {
                          setSearch("");
                          window.setTimeout(() => scrollToSection(section.id), 0);
                        }}
                      >
                        {section.name}
                      </Chip>
                    ))}
                  </div>
                </section>
              )
            ) : (
              <>
                {favoriteItems.length > 0 && (
                  <section className="g-section g-favorites" aria-labelledby="g-favorites-title">
                    <header className="g-section__head">
                      <h2 id="g-favorites-title">Ваше любимое</h2>
                    </header>
                    <div className="g-favorites__row">
                      {favoriteItems.map(({ item, sectionName }) => (
                        <button key={item.id} type="button" className="g-fav-chip" onClick={() => openItem(item, sectionName, null)}>
                          <Heart size={14} fill="currentColor" aria-hidden="true" />
                          <span>{item.name}</span>
                          <b>{item.is_available ? fromPrice(item) : "Нет"}</b>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                {sections.length ? sections.map((section) => (
                  <Fragment key={section.id}>
                    <section
                      className="g-section"
                      id={sectionDomId(tab!.menu_id, section.id)}
                      data-section-id={section.id}
                      aria-labelledby={`${sectionDomId(tab!.menu_id, section.id)}-title`}
                    >
                      <header className="g-section__head">
                        <h2 id={`${sectionDomId(tab!.menu_id, section.id)}-title`}>{section.name}</h2>
                        <span>{section.items.length}</span>
                      </header>
                      <ItemGrid
                        items={section.items}
                        sectionName={section.name}
                        favorites={favoriteSet}
                    counts={counts}
                        onOpen={openItem}
                        onQuickAdd={quickAdd}
                    onQuickRemove={quickRemove}
                        cascade={cascadeNext}
                      />
                    </section>
                  </Fragment>
                )) : (
                  <EmptyState icon={<Clock3 size={28} />} title="Меню скоро появится">
                    Здесь пока нет позиций. Загляните чуть позже.
                  </EmptyState>
                )}
              </>
            )}
          </main>
        </>
      )}

      <footer className={`g-footer${choice.totals.count ? " g-footer--with-bar" : ""}`}>Меню на Синице</footer>

      <ChoiceBar totals={choice.totals} onOpen={() => setChoiceOpen(true)} />

      {session.isAdmin && !selected && !choiceOpen && !cashierOpen && !askOpen && (
        <div className={`g-edit-fab${choice.totals.count ? " g-edit-fab--above-bar" : ""}`}>
          <VenueEditFab publicId={publicId} />
        </div>
      )}

      {selected && (
        <ItemSheet
          key={selected.item.id}
          item={selected.item}
          sectionName={selected.sectionName}
          publicId={publicId}
          onClose={closeItem}
          favorite={favoriteSet.has(favoriteKey(selected.item))}
          origin={selected.origin}
          editPath={session.isAdmin ? venueEditPath(publicId, { name: selected.item.name, section: selected.sectionName }) : undefined}
          onToggleFavorite={() => toggleItemFavorite(selected.item)}
          onAdd={(line, from) => {
            choice.add(line);
            closeItem();
            added(selected.item, from);
          }}
        />
      )}

      <ChoiceSheet
        open={choiceOpen}
        views={choice.views}
        totals={choice.totals}
        onClose={closeChoice}
        onQty={choice.setQty}
        onRemove={removeFromChoice}
        onRetry={choice.retry}
        onShow={showAtCashier}
      />

      {cashierOpen && (
        <CashierView venueName={subtitle ? `${title} · ${subtitle}` : title} views={choice.views} totals={choice.totals} onClose={closeCashier} from={cashierFrom} />
      )}

      <AskSheet
        open={askOpen}
        onClose={() => setAskOpen(false)}
        publicId={publicId}
        assistant={data.assistant}
        onPick={(pick: AskPick) => {
          const entry = catalog.find(({ item }) => item.id === pick.id || (pick.item_key && item.item_key === pick.item_key));
          setAskOpen(false);
          if (!entry) {
            showToast("Меню обновилось — позиция не найдена");
            return;
          }
          setTabId(entry.tabId);
          openItem(entry.item, entry.sectionName, null);
        }}
      />

      <MotionSheet open={openInMax} onClose={() => setOpenInMax(false)} title="Откройте в MAX">
        <div className="g-open-in-max">
          <p>Избранное сохраняется в вашем аккаунте MAX. Откройте меню в мини-приложении — там можно отмечать ♡.</p>
          {maxDeepLink(session.launchUrl, startPayload) ? (
            <ButtonLink href={maxDeepLink(session.launchUrl, startPayload)!} rel="noopener">Открыть в MAX</ButtonLink>
          ) : (
            <p className="g-muted">Ссылка на бота MAX не настроена. Откройте меню из чата с ботом заведения.</p>
          )}
        </div>
      </MotionSheet>
    </div>
  );
}
