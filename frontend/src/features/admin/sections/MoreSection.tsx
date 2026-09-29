import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Bell, BellRing, ChevronRight, Copy, Eye, MessageCircle, QrCode, Store, Upload, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { fetchAuthBootstrap } from "../../../api/auth";
import { IconButton } from "../../../design";
import { maxDeepLink } from "../../../design/screens";
import { share, useBackButton } from "../../../max";
import { MenuUpload } from "../../imports/MenuUpload";
import type { Restaurant } from "../../../api/restaurants";
import { showToast } from "../../../design/toast";
import type { CabinetContext } from "../shell/CabinetShell";
import { MessagesPage } from "./MessagesPage";
import { NotificationsPage } from "./NotificationsPage";
import { QrPage } from "./QrPage";
import { TeamPage } from "./TeamPage";
import { VenuePage } from "./VenuePage";
import "./more.css";

interface Page {
  key: string;
  title: string;
  hint: string;
  icon: ReactNode;
}

const PAGES: Page[] = [
  { key: "venue", title: "Заведение и точки", hint: "Название, адреса, новая точка", icon: <Store size={22} /> },
  { key: "qr", title: "QR и ссылка", hint: "Тейбл-тент A6 для печати", icon: <QrCode size={22} /> },
  { key: "team", title: "Администраторы", hint: "Пригласить ссылкой", icon: <Users size={22} /> },
  { key: "messages", title: "Сообщения", hint: "Вопросы гостей этой точке", icon: <MessageCircle size={22} /> },
  { key: "notifications", title: "Рассылки", hint: "Новинки для подписчиков", icon: <Bell size={22} /> },
  { key: "import", title: "Импорт меню", hint: "PDF или фото меню в черновик", icon: <Upload size={22} /> },
];

/** «Ещё»: everything that is not the daily menu work, one tap away. */
export function MoreSection({ context, page, onOpen, onPoint }: {
  context: CabinetContext;
  page: string | null;
  onOpen: (page: string | null) => void;
  /** Open another point of the venue on a page of «Ещё». */
  onPoint: (point: Restaurant, page: string) => void;
}) {
  const { point } = context;
  const bootstrap = useQuery({ queryKey: ["auth-bootstrap"], queryFn: fetchAuthBootstrap, retry: 1 });
  const current = PAGES.find((item) => item.key === page) ?? null;
  // Native MAX «Назад» on a subpage returns to the list.
  useBackButton(current ? () => onOpen(null) : null);

  if (current) {
    return (
      <section className="cabinet-section" aria-labelledby="more-page-title">
        <div className="cabinet-subheader">
          <IconButton aria-label="Назад к разделу «Ещё»" icon={<ArrowLeft size={22} />} onClick={() => onOpen(null)} />
          <h1 id="more-page-title" className="cabinet-title">{current.title}</h1>
        </div>
        {current.key === "venue" && (
          <VenuePage
            context={context}
            onOpenPoint={(target) => onPoint(target, "venue")}
            onPointCreated={(created) => { showToast(`Точка «${created.name}» готова — вот её QR`, { tone: "success" }); onPoint(created, "qr"); }}
          />
        )}
        {current.key === "qr" && <QrPage point={point} />}
        {current.key === "team" && <TeamPage pointId={point.id} venueName={point.venue_name ?? point.name} />}
        {current.key === "notifications" && <NotificationsPage pointId={point.id} />}
        {current.key === "messages" && <MessagesPage pointId={point.id} pointName={point.name} />}
        {current.key === "import" && <MenuUpload restaurantId={point.id} />}
      </section>
    );
  }

  const cabinetLink = maxDeepLink(bootstrap.data?.max_launch_url, `manage_${point.public_id}`)
    ?? `${window.location.origin}/manage/${point.public_id}`;
  return (
    <section className="cabinet-section" aria-labelledby="more-title">
      <h1 id="more-title" className="cabinet-title">Ещё</h1>
      <ul className="cabinet-list">
        {PAGES.map((item) => (
          <li key={item.key}>
            <button type="button" className="cabinet-list__row" onClick={() => onOpen(item.key)}>
              <span className="cabinet-list__icon" aria-hidden="true">{item.icon}</span>
              <span className="cabinet-list__text"><strong>{item.title}</strong><small>{item.hint}</small></span>
              <ChevronRight size={20} aria-hidden="true" />
            </button>
          </li>
        ))}
        <li>
          {point.current_published_version_id
            ? (
              <Link className="cabinet-list__row" to={`/r/${point.public_id}`}>
                <span className="cabinet-list__icon" aria-hidden="true"><Eye size={22} /></span>
                <span className="cabinet-list__text"><strong>Посмотреть как гость</strong><small>Опубликованное меню этой точки</small></span>
                <ChevronRight size={20} aria-hidden="true" />
              </Link>
            )
            : (
              <p className="cabinet-list__row cabinet-list__row--static">
                <span className="cabinet-list__icon" aria-hidden="true"><Eye size={22} /></span>
                <span className="cabinet-list__text"><strong>Гостевой вид</strong><small>Появится после публикации меню</small></span>
              </p>
            )}
        </li>
        <li>
          <Link className="cabinet-list__row" to="/notifications">
            <span className="cabinet-list__icon" aria-hidden="true"><BellRing size={22} /></span>
            <span className="cabinet-list__text"><strong>Мои уведомления</strong><small>Что присылает бот вам</small></span>
            <ChevronRight size={20} aria-hidden="true" />
          </Link>
        </li>
        <li>
          <button type="button" className="cabinet-list__row" onClick={() => void share({ link: cabinetLink })}>
            <span className="cabinet-list__icon" aria-hidden="true"><Copy size={22} /></span>
            <span className="cabinet-list__text"><strong>Ссылка на кабинет</strong><small>Откроется только у администраторов</small></span>
          </button>
        </li>
      </ul>
    </section>
  );
}
