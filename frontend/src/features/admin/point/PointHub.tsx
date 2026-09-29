import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Bell,
  ChevronRight,
  Eye,
  MapPin,
  MessageCircle,
  Palette,
  Plus,
  QrCode,
  Settings2,
  SquareMenu,
  Upload,
  Users,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import type { Restaurant } from "../../../api/restaurants";
import { listVenueMenus, venueKeys } from "../../../api/venues";
import { Button, Sheet, Skeleton } from "../../../design";
import { haptics } from "../../../max";
import { NewPointForm } from "../shell/NewVenue";
import type { CabinetContext, CabinetSection } from "../shell/CabinetShell";
import "./point.css";

interface Tile {
  key: string;
  title: string;
  hint: string;
  icon: ReactNode;
  section: CabinetSection;
  page: string | null;
}

const TILES: Tile[] = [
  { key: "menu", title: "Меню", hint: "Позиции, цены, наличие", icon: <SquareMenu size={24} />, section: "menu", page: null },
  { key: "design", title: "Оформление", hint: "Цвета, плитки, шрифт", icon: <Palette size={24} />, section: "design", page: null },
  { key: "qr", title: "QR и ссылка", hint: "Печать и отправка гостям", icon: <QrCode size={24} />, section: "more", page: "qr" },
  { key: "analytics", title: "Аналитика", hint: "Просмотры и поиск", icon: <BarChart3 size={24} />, section: "analytics", page: null },
  { key: "team", title: "Команда", hint: "Администраторы", icon: <Users size={24} />, section: "more", page: "team" },
  { key: "messages", title: "Сообщения", hint: "Вопросы гостей", icon: <MessageCircle size={24} />, section: "more", page: "messages" },
  { key: "notifications", title: "Рассылки", hint: "Новинки подписчикам", icon: <Bell size={24} />, section: "more", page: "notifications" },
  { key: "import", title: "Импорт меню", hint: "Из фото или PDF", icon: <Upload size={24} />, section: "more", page: "import" },
  { key: "settings", title: "Данные точки", hint: "Название, адрес, часовой пояс", icon: <Settings2 size={24} />, section: "more", page: "venue" },
];

/**
 * «Точка»: the page of one point with everything about it in one place. The Home list opens
 * this page (not the menu editor); every tile leads to one section of the cabinet.
 */
export function PointHub({ context, onOpen, onPoint, onCreated }: {
  context: CabinetContext;
  onOpen: (section: CabinetSection, page: string | null) => void;
  onPoint: (point: Restaurant) => void;
  onCreated: (point: Restaurant) => void;
}) {
  const { point, venuePoints } = context;
  const [adding, setAdding] = useState(false);
  const menus = useQuery({ queryKey: venueKeys.menus(point.venue_id), queryFn: () => listVenueMenus(point.venue_id) });
  const here = (menus.data ?? []).filter((menu) => menu.point_ids.includes(point.id) && !menu.archived_at);
  const published = Boolean(point.current_published_version_id);
  const changes = here.reduce((sum, menu) => sum + (menu.unpublished_changes ?? 0), 0);

  return (
    <div className="point-hub">
      <header className="point-hub__head">
        <span className="point-hub__icon" aria-hidden="true"><MapPin size={26} /></span>
        <div className="point-hub__title">
          <h1 className="cabinet-title">{point.name}</h1>
          <p>{point.address ?? "Адрес не указан"}</p>
        </div>
        <span className={`point-status${published ? " point-status--live" : ""}`}>
          {published ? "Меню видно гостям" : "Меню не опубликовано"}
        </span>
      </header>

      <section className="point-hub__menus" aria-label="Меню точки">
        {menus.isPending && <Skeleton height={56} radius="card" />}
        {menus.isSuccess && here.length === 0 && (
          <button type="button" className="point-menu point-menu--empty" onClick={() => onOpen("menu", null)}>
            <span><strong>Меню ещё нет</strong><small>Создайте меню или импортируйте его из фото</small></span>
            <ChevronRight size={20} aria-hidden="true" />
          </button>
        )}
        {here.map((menu) => (
          <button key={menu.id} type="button" className="point-menu" onClick={() => { haptics.selection(); onOpen("menu", null); }}>
            <span>
              <strong>{menu.title}</strong>
              <small>
                {menu.published_version ? `Версия ${menu.published_version} у гостей` : "Не опубликовано"}
                {menu.unpublished_changes > 0 ? ` · изменений: ${menu.unpublished_changes}` : ""}
              </small>
            </span>
            <ChevronRight size={20} aria-hidden="true" />
          </button>
        ))}
        {changes > 0 && <p className="point-hub__note" role="status">Есть неопубликованные изменения: {changes}</p>}
      </section>

      <ul className="point-tiles" aria-label="Разделы точки">
        {TILES.map((tile) => (
          <li key={tile.key}>
            <button type="button" className="point-tile" onClick={() => { haptics.selection(); onOpen(tile.section, tile.page); }}>
              <span className="point-tile__icon" aria-hidden="true">{tile.icon}</span>
              <span className="point-tile__title">{tile.title}</span>
              <span className="point-tile__hint">{tile.hint}</span>
            </button>
          </li>
        ))}
        <li>
          {published ? (
            <Link className="point-tile" to={`/r/${point.public_id}`} onClick={() => haptics.selection()}>
              <span className="point-tile__icon" aria-hidden="true"><Eye size={24} /></span>
              <span className="point-tile__title">Как гость</span>
              <span className="point-tile__hint">Опубликованное меню</span>
            </Link>
          ) : (
            <span className="point-tile point-tile--off" aria-disabled="true">
              <span className="point-tile__icon" aria-hidden="true"><Eye size={24} /></span>
              <span className="point-tile__title">Как гость</span>
              <span className="point-tile__hint">Появится после публикации</span>
            </span>
          )}
        </li>
      </ul>

      <section className="point-hub__points" aria-labelledby="point-hub-points">
        <h2 id="point-hub-points">Точки заведения</h2>
        <ul className="point-list">
          {venuePoints.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="point-list__row"
                aria-current={item.id === point.id || undefined}
                disabled={item.id === point.id}
                onClick={() => { haptics.selection(); onPoint(item); }}
              >
                <span className="point-list__icon" aria-hidden="true"><MapPin size={20} /></span>
                <span className="point-list__text"><strong>{item.name}</strong><small>{item.address ?? "Адрес не указан"}</small></span>
                {item.id === point.id ? <span className="point-list__here">Открыта</span> : <ChevronRight size={20} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
        <Button variant="secondary" icon={<Plus size={20} />} onClick={() => setAdding(true)}>Новая точка</Button>
      </section>

      <Sheet open={adding} onClose={() => setAdding(false)} title="Новая точка">
        <NewPointForm venueId={point.venue_id} onCreated={(created) => { setAdding(false); onCreated(created); }} />
      </Sheet>
    </div>
  );
}
