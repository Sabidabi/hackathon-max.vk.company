import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Send } from "lucide-react";
import { useState } from "react";

import { createCampaign, fetchCampaignPreview, listCampaigns } from "../../../api/notifications";
import { Button, EmptyState, Skeleton, Textarea, TextInput } from "../../../design";
import { showToast } from "../../../design/toast";
import { haptics } from "../../../max";

const dateFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });

/**
 * «Рассылки» (P1-DOC-11): only to guests who subscribed to this point, through the outbox —
 * at most once in 72 hours and never at night; the server decides when sending is allowed.
 */
export function NotificationsPage({ pointId }: { pointId: string }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const preview = useQuery({ queryKey: ["notification-preview", pointId], queryFn: () => fetchCampaignPreview(pointId) });
  const campaigns = useQuery({ queryKey: ["notification-campaigns", pointId], queryFn: () => listCampaigns(pointId), refetchInterval: 10_000 });
  const send = useMutation({
    mutationFn: () => createCampaign(pointId, { title: title.trim(), body: body.trim(), idempotency_key: idempotencyKey }),
    onSuccess: () => {
      haptics.notify("success");
      setTitle("");
      setBody("");
      setIdempotencyKey(crypto.randomUUID());
      showToast("Рассылка в очереди", { tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["notification-preview", pointId] });
      void queryClient.invalidateQueries({ queryKey: ["notification-campaigns", pointId] });
    },
    onError: () => haptics.notify("error"),
  });
  const recipients = preview.data?.eligible_recipients ?? 0;
  const blocked = preview.data && !preview.data.can_send_now;
  const canSend = Boolean(title.trim() && body.trim() && preview.data?.can_send_now && !send.isPending);
  return (
    <div className="more-page">
      <form className="cabinet-card cabinet-form" onSubmit={(event) => { event.preventDefault(); if (canSend) send.mutate(); }}>
        <TextInput label="Заголовок" maxLength={80} placeholder="Новый сезонный напиток" value={title} onChange={(event) => setTitle(event.target.value)} />
        <Textarea label="Сообщение" rows={4} maxLength={500} placeholder="Коротко и по делу" value={body} onChange={(event) => setBody(event.target.value)} />
        <p className="cabinet-muted">
          {preview.isPending ? "Считаем подписчиков…" : blocked
            ? preview.data?.next_available_at ? `Следующая отправка — ${new Date(preview.data.next_available_at).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}` : "Сейчас отправить нельзя: нет подписчиков или ночное время"
            : `Получат подписчики точки: ${recipients}. Не чаще раза в 72 часа.`}
        </p>
        {send.isError && <p className="cabinet-error" role="alert">{send.error.message}</p>}
        <Button type="submit" icon={<Send size={20} />} disabled={!canSend} loading={send.isPending}>Отправить{recipients ? ` · ${recipients}` : ""}</Button>
      </form>
      <section className="more-block" aria-labelledby="campaigns-title">
        <h2 id="campaigns-title">История</h2>
        {campaigns.isPending && <div className="more-skeleton">{[0, 1].map((row) => <Skeleton key={row} height={56} radius="control" />)}</div>}
        {campaigns.data && !campaigns.data.length && <EmptyState icon={<Bell size={28} />} title="Рассылок ещё не было">Подписчики получают и уведомление о новом меню после публикации.</EmptyState>}
        {campaigns.data && campaigns.data.length > 0 && (
          <ul className="cabinet-list">
            {campaigns.data.map((campaign) => (
              <li key={campaign.id}>
                <div className="cabinet-list__row cabinet-list__row--static">
                  <span className="cabinet-list__text"><strong>{campaign.title}</strong><small>{dateFormat.format(new Date(campaign.created_at))}</small></span>
                  <span className="more-status">{campaign.status === "completed" ? `${campaign.sent_count} из ${campaign.recipient_count}` : campaign.status === "sending" ? "Отправляется" : "В очереди"}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
