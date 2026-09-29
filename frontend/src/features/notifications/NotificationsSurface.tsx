import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bell, BellOff, CheckCircle2, Info, LifeBuoy, MessageCircle, RotateCcw, Store, WifiOff, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { fetchAuthBootstrap, fetchCurrentUser } from "../../api/auth";
import { Button, EmptyState, IconButton, OpenInMax, Skeleton, Splash, Switch } from "../../design";
import { showToast } from "../../design/toast";
import { haptics, openMaxLink, useBackButton } from "../../max";
import {
  fetchNotificationSettings,
  removeItemSubscription,
  setAdminKind,
  setVenueNews,
  stopAllMarketing,
  type AdminKind,
  type NotificationSettings,
} from "./api";
import "./notifications.css";

const QUERY_KEY = ["notification-settings"];

/** Admin notification types: what the admin gets and when. */
export const ADMIN_KIND_LABELS: Record<AdminKind, { title: string; hint: string }> = {
  a8_point_message: { title: "Сообщения гостей", hint: "Вопрос гостя точке — сразу" },
  a1_import_ready: { title: "Импорт меню готов", hint: "Файл распознан, проверьте позиции" },
  a2_admin_joined: { title: "Новый администратор", hint: "Кто-то принял приглашение" },
  a3_menu_published: { title: "Публикации коллег", hint: "Другой админ опубликовал меню" },
  a4_draft_stale: { title: "Забытый черновик", hint: "Изменения не опубликованы больше суток" },
  a5_stop_list_demand: { title: "Спрос на стоп-лист", hint: "10+ гостей за день открыли позицию, которой нет" },
  a6_empty_searches: { title: "Пустые поиски", hint: "Гости ищут то, чего нет в меню" },
  a7_weekly_summary: { title: "Недельная сводка", hint: "Понедельник, 10:00 по времени точки" },
};

type Patch =
  | { kind: "venue"; restaurantId: string; enabled: boolean }
  | { kind: "item"; pointId: string; itemKey: string }
  | { kind: "admin"; venueId: string; type: AdminKind; enabled: boolean };

function applyPatch(data: NotificationSettings, patch: Patch): NotificationSettings {
  if (patch.kind === "venue") {
    return { ...data, venues: data.venues.map((venue) => venue.restaurant_id === patch.restaurantId ? { ...venue, notifications_enabled: patch.enabled } : venue) };
  }
  if (patch.kind === "item") {
    return { ...data, items: data.items.filter((item) => !(item.point_id === patch.pointId && item.item_key === patch.itemKey)) };
  }
  return {
    ...data,
    admin: data.admin.map((venue) => venue.venue_id !== patch.venueId ? venue : {
      ...venue,
      kinds: venue.kinds.map((entry) => entry.kind === patch.type ? { ...entry, enabled: patch.enabled } : entry),
    }),
  };
}

function send(patch: Patch): Promise<void> {
  if (patch.kind === "venue") return setVenueNews(patch.restaurantId, patch.enabled);
  if (patch.kind === "item") return removeItemSubscription(patch.pointId, patch.itemKey);
  return setAdminKind(patch.venueId, patch.type, patch.enabled);
}

/** «Разрешить сообщения»: nothing is sent until the user has started a dialog with the bot. */
function BotAccessCard({ bot }: { bot: NotificationSettings["bot"] }) {
  if (bot.messages_allowed) {
    return (
      <p className="nt-access nt-access--ok" role="status">
        <CheckCircle2 size={20} aria-hidden="true" />
        <span>Сообщения от бота Синицы разрешены</span>
      </p>
    );
  }
  return (
    <section className="nt-access" aria-labelledby="nt-access-title">
      <span className="nt-access__icon" aria-hidden="true"><MessageCircle size={24} /></span>
      <div className="nt-access__text">
        <h2 id="nt-access-title">Разрешите сообщения</h2>
        <p>Бот напишет, только когда вы откроете с ним диалог. Нажмите «Начать» в чате.</p>
      </div>
      <Button
        icon={<MessageCircle size={20} />}
        disabled={!bot.allow_link}
        onClick={() => { if (bot.allow_link) { haptics.selection(); openMaxLink(bot.allow_link); } }}
      >
        Открыть бота
      </Button>
      {!bot.allow_link && <p className="nt-note">Бот ещё не подключён к этому стенду.</p>}
    </section>
  );
}

function SettingsSkeleton() {
  return (
    <div className="nt-body" aria-busy="true" aria-label="Загружаем настройки">
      <Skeleton height={72} radius="card" />
      <Skeleton width="40%" height={20} />
      {[0, 1, 2].map((row) => <Skeleton key={row} height={56} radius="control" />)}
    </div>
  );
}

/**
 * «Уведомления»: the guest's
 * subscriptions by point and position, and the admin's types А1–А8 per venue. Every switch
 * is saved on the server at once (optimistic, rolled back on error).
 */
export function NotificationsSurface() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [confirmStop, setConfirmStop] = useState(false);
  const back = () => (window.history.length > 1 ? navigate(-1) : navigate("/"));
  useBackButton(back);
  const me = useQuery({ queryKey: ["current-user"], queryFn: fetchCurrentUser, retry: false, staleTime: 60_000 });
  const bootstrap = useQuery({ queryKey: ["auth-bootstrap"], queryFn: fetchAuthBootstrap, retry: false, staleTime: 5 * 60_000 });
  const settings = useQuery({ queryKey: QUERY_KEY, queryFn: fetchNotificationSettings, enabled: Boolean(me.data) });

  const change = useMutation({
    mutationFn: send,
    onMutate: async (patch) => {
      haptics.selection();
      await client.cancelQueries({ queryKey: QUERY_KEY });
      const previous = client.getQueryData<NotificationSettings>(QUERY_KEY);
      if (previous) client.setQueryData(QUERY_KEY, applyPatch(previous, patch));
      return { previous };
    },
    onError: (error, _patch, context) => {
      if (context?.previous) client.setQueryData(QUERY_KEY, context.previous);
      haptics.notify("error");
      showToast(error.message, { tone: "danger" });
    },
  });
  const stop = useMutation({
    mutationFn: stopAllMarketing,
    onSuccess: () => {
      haptics.notify("success");
      setConfirmStop(false);
      showToast("Вы отписались от новинок и позиций", { tone: "success" });
      void client.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error) => showToast(error.message, { tone: "danger" }),
  });

  if (me.isPending) return <Splash label="Открываем уведомления" />;
  if (!me.data) {
    return (
      <OpenInMax launchUrl={bootstrap.data?.max_launch_url} startPayload="settings" title="Уведомления — в MAX">
        Настройки уведомлений привязаны к вашему аккаунту MAX.
      </OpenInMax>
    );
  }

  const data = settings.data;
  const guestHasAny = Boolean(data && (data.venues.length || data.items.length));
  return (
    <main className="nt-screen">
      <header className="nt-header">
        <IconButton aria-label="Назад" icon={<ArrowLeft size={22} />} onClick={back} />
        <h1 className="nt-title">Уведомления</h1>
      </header>
      {settings.isPending && <SettingsSkeleton />}
      {settings.isError && (
        <div className="nt-body">
          <EmptyState
            tone="danger"
            icon={<WifiOff size={28} />}
            title="Не удалось загрузить настройки"
            action={<Button icon={<RotateCcw size={20} />} onClick={() => void settings.refetch()}>Попробовать снова</Button>}
          >
            Проверьте интернет и попробуйте снова.
          </EmptyState>
        </div>
      )}
      {data && (
        <div className="nt-body">
          <BotAccessCard bot={data.bot} />

          <section className="nt-block" aria-labelledby="nt-venues-title">
            <div className="nt-block__head">
              <h2 id="nt-venues-title">Новинки заведений</h2>
              <p>Не чаще раза в неделю, не ночью. Можно отключить кнопкой под сообщением.</p>
            </div>
            {data.venues.length ? (
              <ul className="nt-list">
                {data.venues.map((venue) => (
                  <li key={venue.restaurant_id}>
                    <Switch
                      checked={venue.notifications_enabled}
                      label={venue.name}
                      description={venue.notifications_enabled ? "Пришлём о новых позициях" : "Только в избранном"}
                      onChange={(enabled) => change.mutate({ kind: "venue", restaurantId: venue.restaurant_id, enabled })}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Store size={28} />} title="Пока нет избранных заведений">
                Нажмите ♡ и колокольчик в меню кофейни — и узнаете о новинках первыми.
              </EmptyState>
            )}
          </section>

          {data.items.length > 0 && (
            <section className="nt-block" aria-labelledby="nt-items-title">
              <div className="nt-block__head">
                <h2 id="nt-items-title">Сообщить, когда появится</h2>
                <p>Одно сообщение, когда позиция вернётся в меню.</p>
              </div>
              <ul className="nt-list">
                {data.items.map((item) => (
                  <li key={`${item.point_id}:${item.item_key}`} className="nt-row">
                    <Bell size={20} aria-hidden="true" className="nt-row__icon" />
                    <span className="nt-row__text"><strong>{item.item_name}</strong><small>{item.point_name}</small></span>
                    <IconButton
                      aria-label={`Не сообщать о «${item.item_name}»`}
                      icon={<X size={20} />}
                      onClick={() => change.mutate({ kind: "item", pointId: item.point_id, itemKey: item.item_key })}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {guestHasAny && (
            confirmStop ? (
              <div className="nt-confirm" role="group" aria-label="Отписаться от всего">
                <p>Выключить все новинки и «Сообщить, когда появится»? Сообщения администратора останутся.</p>
                <div className="nt-confirm__actions">
                  <Button variant="danger" icon={<BellOff size={20} />} loading={stop.isPending} onClick={() => stop.mutate()}>Отписаться</Button>
                  <Button variant="ghost" onClick={() => setConfirmStop(false)}>Отмена</Button>
                </div>
              </div>
            ) : (
              <Button variant="ghost" icon={<BellOff size={20} />} onClick={() => setConfirmStop(true)}>Отписаться от всего</Button>
            )
          )}

          {data.admin.map((venue) => (
            <section key={venue.venue_id} className="nt-block" aria-labelledby={`nt-admin-${venue.venue_id}`}>
              <div className="nt-block__head">
                <h2 id={`nt-admin-${venue.venue_id}`}>{venue.name}</h2>
                <p>Для администраторов. Выключение касается только вас.</p>
              </div>
              <ul className="nt-list">
                {venue.kinds.slice().sort((a, b) => order(a.kind) - order(b.kind)).map((entry) => (
                  <li key={entry.kind}>
                    <Switch
                      checked={entry.enabled}
                      label={ADMIN_KIND_LABELS[entry.kind].title}
                      description={ADMIN_KIND_LABELS[entry.kind].hint}
                      onChange={(enabled) => change.mutate({ kind: "admin", venueId: venue.venue_id, type: entry.kind, enabled })}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <footer className="nt-footer">
            <p className="nt-note"><Info size={16} aria-hidden="true" />Промокодов и рассылок всем пользователям нет — только то, на что вы подписались.</p>
            <Button
              variant="secondary"
              icon={<LifeBuoy size={20} />}
              disabled={!data.bot.support_link}
              onClick={() => { if (data.bot.support_link) openMaxLink(data.bot.support_link); }}
            >
              Написать в поддержку
            </Button>
          </footer>
        </div>
      )}
    </main>
  );
}

const ORDER = Object.keys(ADMIN_KIND_LABELS) as AdminKind[];
const order = (kind: AdminKind) => ORDER.indexOf(kind);
