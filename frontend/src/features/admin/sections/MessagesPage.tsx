import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, Camera, CircleCheck, MessageCircle, Send, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button, EmptyState, IconButton, Skeleton, Textarea } from "../../../design";
import { showToast } from "../../../design/toast";
import { haptics } from "../../../max";
import {
  closeConversation,
  fetchConversation,
  listConversations,
  replyToConversation,
  setGuestBlocked,
  type ConversationSummary,
} from "../../notifications/api";
import "../../notifications/messages.css";

const timeFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const STATUS: Record<ConversationSummary["status"], string> = { open: "Ждёт ответа", answered: "Отвечено", closed: "Закрыт" };

function Dialog({ id, pointName, onBack }: { id: string; pointName: string; onBack: () => void }) {
  const client = useQueryClient();
  const [text, setText] = useState("");
  const [confirmBlock, setConfirmBlock] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const detail = useQuery({ queryKey: ["conversation", id], queryFn: () => fetchConversation(id), refetchInterval: 10_000 });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["conversation", id] });
    void client.invalidateQueries({ queryKey: ["conversations"] });
  };
  const reply = useMutation({
    mutationFn: () => replyToConversation(id, text.trim()),
    onSuccess: (data) => {
      haptics.notify("success");
      setText("");
      client.setQueryData(["conversation", id], data);
      void client.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (error) => { haptics.notify("error"); showToast(error.message, { tone: "danger" }); },
  });
  const close = useMutation({
    mutationFn: () => closeConversation(id),
    onSuccess: () => { showToast("Диалог закрыт", { tone: "success" }); refresh(); },
    onError: (error) => showToast(error.message, { tone: "danger" }),
  });
  const block = useMutation({
    mutationFn: (blocked: boolean) => setGuestBlocked(id, blocked),
    onSuccess: (_, blocked) => { setConfirmBlock(false); showToast(blocked ? "Гость заблокирован" : "Гость разблокирован", { tone: "success" }); refresh(); },
    onError: (error) => showToast(error.message, { tone: "danger" }),
  });
  const count = detail.data?.messages.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [count]);

  const data = detail.data;
  return (
    <div className="msg-dialog">
      <div className="msg-dialog__head">
        <IconButton aria-label="Ко всем диалогам" icon={<ArrowLeft size={22} />} onClick={onBack} />
        <span className="msg-dialog__who">
          <strong>{data ? data.guest_name : "Диалог"}</strong>
          <small>{data ? `№${data.number} · ${STATUS[data.status]}` : " "}</small>
        </span>
      </div>
      {detail.isPending && <div className="more-skeleton">{[0, 1, 2].map((row) => <Skeleton key={row} height={48} radius="control" />)}</div>}
      {detail.isError && <p className="cabinet-error" role="alert">{detail.error.message}</p>}
      {data && (
        <>
          <ol className="msg-thread" aria-label="Сообщения">
            {data.messages.map((message) => (
              <li key={message.id} className={`msg-bubble msg-bubble--${message.direction}`}>
                {message.text && <p>{message.text}</p>}
                {message.photo_count > 0 && <p className="msg-bubble__photo"><Camera size={16} aria-hidden="true" />Фото: {message.photo_count} — смотрите в чате бота</p>}
                <time dateTime={message.created_at}>{message.direction === "out" ? `${pointName} · ` : ""}{timeFormat.format(new Date(message.created_at))}</time>
              </li>
            ))}
          </ol>
          <div ref={end} />
          {data.status !== "closed" && !data.blocked ? (
            <form className="msg-reply" onSubmit={(event) => { event.preventDefault(); if (text.trim() && !reply.isPending) reply.mutate(); }}>
              <Textarea label="Ответ гостю" hint={`Гость увидит подпись «${pointName}», не ваше имя.`} rows={3} maxLength={2000} value={text} onChange={(event) => setText(event.target.value)} />
              <Button type="submit" icon={<Send size={20} />} disabled={!text.trim()} loading={reply.isPending}>Отправить</Button>
            </form>
          ) : (
            <p className="cabinet-muted">{data.blocked ? "Гость заблокирован: новые сообщения не принимаются." : "Диалог закрыт. Гость может написать снова."}</p>
          )}
          <div className="msg-actions">
            {data.status !== "closed" && (
              <Button variant="ghost" icon={<CircleCheck size={20} />} loading={close.isPending} onClick={() => close.mutate()}>Закрыть диалог</Button>
            )}
            {data.blocked ? (
              <Button variant="ghost" icon={<ShieldCheck size={20} />} loading={block.isPending} onClick={() => block.mutate(false)}>Разблокировать</Button>
            ) : confirmBlock ? (
              <span className="msg-confirm">
                <Button variant="danger" icon={<Ban size={20} />} loading={block.isPending} onClick={() => block.mutate(true)}>Заблокировать гостя</Button>
                <Button variant="ghost" onClick={() => setConfirmBlock(false)}>Отмена</Button>
              </span>
            ) : (
              <Button variant="ghost" icon={<Ban size={20} />} onClick={() => setConfirmBlock(true)}>Заблокировать</Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * «Ещё → Сообщения»: guests' questions to this point through the bot. Only
 * admins of the venue see them; answers go to the guest in MAX signed by the point.
 */
export function MessagesPage({ pointId, pointName }: { pointId: string; pointName: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["conversations", pointId], queryFn: () => listConversations(pointId), refetchInterval: 15_000 });
  if (openId) return <div className="more-page"><Dialog id={openId} pointName={pointName} onBack={() => setOpenId(null)} /></div>;
  return (
    <div className="more-page">
      {list.isPending && <div className="more-skeleton">{[0, 1, 2].map((row) => <Skeleton key={row} height={64} radius="control" />)}</div>}
      {list.isError && <p className="cabinet-error" role="alert">{list.error.message}</p>}
      {list.data && !list.data.length && (
        <EmptyState icon={<MessageCircle size={28} />} title="Сообщений пока нет">
          Гости пишут кнопкой «Написать в кофейню» в меню. Новое сообщение придёт вам в бот.
        </EmptyState>
      )}
      {list.data && list.data.length > 0 && (
        <ul className="cabinet-list">
          {list.data.map((item) => (
            <li key={item.id}>
              <button type="button" className="cabinet-list__row msg-row" onClick={() => { haptics.selection(); setOpenId(item.id); }}>
                <span className="cabinet-list__icon" aria-hidden="true"><MessageCircle size={22} /></span>
                <span className="cabinet-list__text">
                  <strong>{item.guest_name}{item.blocked ? " · заблокирован" : ""}</strong>
                  <small className="msg-row__preview">{item.last_message}</small>
                </span>
                <span className="msg-row__meta">
                  <small>{timeFormat.format(new Date(item.last_message_at))}</small>
                  {item.unread > 0
                    ? <span className="msg-badge" aria-label={`Непрочитанных: ${item.unread}`}>{item.unread}</span>
                    : <small>{STATUS[item.status]}</small>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
