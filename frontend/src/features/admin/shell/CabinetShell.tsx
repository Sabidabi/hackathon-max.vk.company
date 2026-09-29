import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Ellipsis, MapPin, Palette, Sparkles, SquareMenu } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";

import { listRestaurants, type Restaurant } from "../../../api/restaurants";
import { BrandLockup, Button, EmptyState, Skeleton, TabBar, type TabBarItem } from "../../../design";
import { showToast } from "../../../design/toast";
import { haptics } from "../../../max";
import { AiHub } from "../ai/AiHub";
import { DesignSection } from "../design/DesignSection";
import { MenuSection } from "../menu/MenuSection";
import { PointHub } from "../point/PointHub";
import { AnalyticsSection } from "../sections/AnalyticsSection";
import { MoreSection } from "../sections/MoreSection";
import { NewVenue } from "./NewVenue";
import { AccountButton, PointSwitcher } from "./Switcher";
import "./cabinet.css";

export type CabinetSection = "point" | "menu" | "analytics" | "design" | "ai" | "more";
const SECTIONS: CabinetSection[] = ["point", "menu", "analytics", "design", "ai", "more"];

/** What the current point and its venue look like to every section of the cabinet. */
export interface CabinetContext {
  point: Restaurant;
  /** Points of the same venue, in creation order. */
  venuePoints: Restaurant[];
  /** Every point the user administers (all venues). */
  allPoints: Restaurant[];
}

function parsePath(path: string): { section: CabinetSection; page: string | null } {
  const [first = "", second = null] = path.split("/").filter(Boolean);
  // `/manage/<id>` without a tail opens the point page; a link to a position (`?item=`) is
  // handled by the shell and opens the menu.
  const section = (SECTIONS as string[]).includes(first) ? (first as CabinetSection) : "point";
  return { section, page: section === "more" ? second : null };
}

/** Non-admin on `/manage/<id>`: the guest menu of that venue plus a toast that survives navigation. */
function ManageDenied({ publicId }: { publicId: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    showToast("Управление доступно администраторам", 5_000);
    setShown(true);
  }, []);
  return shown ? <Navigate to={`/r/${publicId}`} replace /> : null;
}

/** Where «Редактировать» in the guest menu points: `?section=<name>&item=<name>`. */
function useFocusItem(): { section: string | null; name: string } | null {
  const [params] = useSearchParams();
  const name = params.get("item");
  return useMemo(() => (name ? { section: params.get("section"), name } : null), [name, params]);
}

function ShellSkeleton() {
  return (
    <div className="cabinet cabinet--loading" aria-busy="true" aria-label="Загружаем кабинет">
      <div className="cabinet-header"><Skeleton width={32} height={32} radius="control" /><Skeleton width="55%" height={20} /></div>
      <div className="cabinet-main">
        <div className="cabinet-skeleton-rows">
          <Skeleton width="40%" height={24} />
          {[0, 1, 2, 3, 4].map((row) => <Skeleton key={row} height={56} radius="control" />)}
        </div>
      </div>
    </div>
  );
}

const NAV: Array<TabBarItem<CabinetSection>> = [
  { key: "point", label: "Точка", icon: <MapPin size={24} /> },
  { key: "menu", label: "Меню", icon: <SquareMenu size={24} /> },
  { key: "ai", label: "ИИ", icon: <Sparkles size={24} /> },
  { key: "design", label: "Оформление", icon: <Palette size={24} /> },
  { key: "more", label: "Ещё", icon: <Ellipsis size={24} /> },
];

/**
 * Cabinet frame (P1-DOC-7 «Навигация», P1-DOC-15 «Быстрое переключение»): header with
 * «Заведение ▾ / Точка ▾» and the account; bottom tab bar under 1024 px, a 240 px left column
 * from 1024 px. Switching the point keeps the section and does not reload the app.
 */
export function CabinetShell({ publicId, path }: { publicId: string | null; path: string }) {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const focusItem = useFocusItem();
  const parsed = parsePath(path);
  const section: CabinetSection = !path && focusItem ? "menu" : parsed.section;
  const page = parsed.page;
  const [unsaved, setUnsaved] = useState(false);
  const [changes, setChanges] = useState(0);
  const restaurants = useQuery({ queryKey: ["restaurants"], queryFn: listRestaurants, retry: false });

  // A point missing from a list cached before this screen opened (e.g. just accepted elsewhere):
  // ask the server once more before deciding the user is not its admin.
  const mountedAt = useRef(Date.now());
  const missingPoint = Boolean(publicId && restaurants.data && !restaurants.data.some((item) => item.public_id === publicId));
  const staleList = restaurants.dataUpdatedAt < mountedAt.current;
  const failedSinceMount = restaurants.isError && restaurants.errorUpdatedAt >= mountedAt.current;
  const needsRecheck = missingPoint && staleList && !failedSinceMount;
  useEffect(() => {
    if (needsRecheck && !restaurants.isFetching) void restaurants.refetch();
  }, [needsRecheck, restaurants]);

  const points = restaurants.data ?? [];
  const point = points.find((item) => item.public_id === publicId) ?? (publicId ? undefined : points[0]);
  const venuePoints = useMemo(() => (point ? points.filter((item) => item.venue_id === point.venue_id) : []), [point, points]);

  const go = useCallback((target: Restaurant, nextSection: CabinetSection = section, nextPage: string | null = page) => {
    const tail = nextSection === "menu" && !nextPage ? "menu" : [nextSection, nextPage].filter(Boolean).join("/");
    navigate(`/manage/${target.public_id}/${tail}`);
  }, [navigate, page, section]);

  const switchPoint = useCallback((target: Restaurant) => {
    if (unsaved) {
      showToast("Сохраняем меню — переключитесь через секунду");
      return;
    }
    haptics.selection();
    go(target);
  }, [go, unsaved]);

  if (restaurants.isPending || (missingPoint && !restaurants.isError && (staleList || restaurants.isFetching))) {
    return <ShellSkeleton />;
  }
  if (restaurants.isError) {
    return (
      <main className="cabinet cabinet--centered">
        <EmptyState
          icon={<CircleAlert size={28} />}
          tone="danger"
          title="Не удалось открыть кабинет"
          action={<Button onClick={() => restaurants.refetch()}>Повторить</Button>}
        >
          {restaurants.error.message}
        </EmptyState>
      </main>
    );
  }
  // `manage_<id>` / `/manage/<id>` for a point the server does not list for this user: the guest
  // menu with «Управление доступно администраторам» (P1-DOC-4). The cabinet API would answer 404.
  if (publicId && missingPoint) return <ManageDenied publicId={publicId} />;
  if (!point) return <NewVenue onCreated={(created) => go(created, "menu", null)} first />;
  // `/manage` without a point: the first point's cabinet, keeping a deep link's query.
  if (!publicId) return <Navigate to={`/manage/${point.public_id}/${focusItem ? "menu" : "point"}${search.size ? `?${search}` : ""}`} replace />;

  const context: CabinetContext = { point, venuePoints, allPoints: points };
  // «Новая точка» opens on its QR (P1-DOC-17); a new venue starts with «Как начнём?».
  const onCreated = (created: Restaurant) => (created.venue_id === point.venue_id ? go(created, "more", "qr") : go(created, "menu", null));
  const published = Boolean(point.current_published_version_id);
  const nav = NAV.map((item) => (item.key === "menu" && changes ? { ...item, badge: changes } : item));
  const onNavigate = (key: CabinetSection) => {
    haptics.selection();
    go(point, key, null);
  };

  // Where a card of the AI chat leads: the section that holds its result.
  const openFromAi = (target: "design" | "menu" | "import") => (target === "import" ? go(point, "more", "import") : go(point, target, null));
  let content: ReactNode;
  if (section === "point") {
    content = (
      <PointHub
        context={context}
        onOpen={(next, nextPage) => go(point, next, nextPage)}
        onPoint={(target) => switchPoint(target)}
        onCreated={onCreated}
      />
    );
  } else if (section === "menu") {
    content = <MenuSection context={context} focusItem={focusItem} onUnsavedChange={setUnsaved} onChangesCount={setChanges} />;
  } else if (section === "analytics") {
    content = <AnalyticsSection context={context} onOpenMenu={() => go(point, "menu", null)} />;
  } else if (section === "design") {
    content = <DesignSection context={context} />;
  } else if (section === "ai") {
    content = <AiHub context={context} onOpenSection={openFromAi} />;
  } else {
    content = <MoreSection context={context} page={page} onOpen={(next) => go(point, "more", next)} onPoint={(target, next) => go(target, "more", next)} />;
  }

  return (
    <div className="cabinet" data-section={section}>
      <aside className="cabinet-rail" aria-label="Кабинет">
        <Link className="cabinet-rail__brand" to="/" aria-label="Синица — на главную"><BrandLockup width={160} /></Link>
        <PointSwitcher context={context} onSelect={switchPoint} onCreated={onCreated} layout="stacked" />
        <TabBar<CabinetSection> label="Разделы кабинета" items={nav} value={section} onChange={onNavigate} orientation="vertical" />
        <div className="cabinet-rail__footer">
          {published
            ? <Link className="cabinet-guest-link" to={`/r/${point.public_id}`}>Посмотреть как гость</Link>
            : <p className="cabinet-muted">Гостевой вид — после публикации</p>}
          <AccountButton withName />
        </div>
      </aside>
      <header className="cabinet-header">
        <PointSwitcher context={context} onSelect={switchPoint} onCreated={onCreated} layout="inline" />
        <AccountButton />
      </header>
      <main className="cabinet-main" id="cabinet-content">
        {/* Point switch: a short cross-fade of the section, not a full redraw (P1-DOC-18). */}
        <div className="cabinet-view" key={`${point.id}:${section}:${page ?? ""}`}>{content}</div>
      </main>
      <TabBar<CabinetSection> label="Разделы кабинета" items={nav} value={section} onChange={onNavigate} fixed className="cabinet-tabbar" />
    </div>
  );
}
