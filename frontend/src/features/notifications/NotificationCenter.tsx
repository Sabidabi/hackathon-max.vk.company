import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Check, Send } from "lucide-react";
import { useState } from "react";

import {
  createCampaign,
  fetchCampaignPreview,
  listCampaigns,
} from "../../api/notifications";
import { Help } from "../../components/Help";

export function NotificationCenter({ restaurantId }: { restaurantId: string }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const preview = useQuery({
    queryKey: ["notification-preview", restaurantId],
    queryFn: () => fetchCampaignPreview(restaurantId),
  });
  const campaigns = useQuery({
    queryKey: ["notification-campaigns", restaurantId],
    queryFn: () => listCampaigns(restaurantId),
    refetchInterval: 10_000,
  });
  const send = useMutation({
    mutationFn: () => createCampaign(restaurantId, {
      title: title.trim(),
      body: body.trim(),
      idempotency_key: idempotencyKey,
    }),
    onSuccess: () => {
      setTitle("");
      setBody("");
      setIdempotencyKey(crypto.randomUUID());
      void queryClient.invalidateQueries({ queryKey: ["notification-preview", restaurantId] });
      void queryClient.invalidateQueries({ queryKey: ["notification-campaigns", restaurantId] });
    },
  });
  const recipientCount = preview.data?.eligible_recipients ?? 0;
  const canSend = Boolean(
    title.trim() && body.trim() && preview.data?.can_send_now && !send.isPending,
  );

  return (
    <section className="notification-center">
      <div className="workspace-title">
        <h2>Рассылки</h2>
        <Help label="Правила рассылок">Только подписчикам точки. Не чаще раза в 72 часа, без ночных отправок.</Help>
      </div>
      <div className="campaign-grid">
        <div className="campaign-compose">
          <label><span>Заголовок</span><input maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Новый сезонный напиток" /></label>
          <label><span>Сообщение</span><textarea rows={5} maxLength={500} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Коротко и по делу" /></label>
          <div className="campaign-preview">
            <Bell size={17} />
            <div><strong>{title.trim() || "Предпросмотр"}</strong><p>{body.trim() || "Текст сообщения появится здесь"}</p></div>
          </div>
          {preview.data?.next_available_at && <p className="muted">Следующая отправка: {new Date(preview.data.next_available_at).toLocaleString("ru-RU")}</p>}
          {send.isError && <p className="form-error" role="alert">{send.error.message}</p>}
          {send.isSuccess && <p className="form-success"><Check size={15} />Рассылка в очереди</p>}
          <button type="button" disabled={!canSend} onClick={() => send.mutate()}><Send size={16} />Отправить · {recipientCount}</button>
        </div>
        <div className="campaign-history">
          <h3>История</h3>
          {campaigns.data?.length ? campaigns.data.map((campaign) => (
            <article key={campaign.id}>
              <div><strong>{campaign.title}</strong><small>{new Date(campaign.created_at).toLocaleDateString("ru-RU")}</small></div>
              <span>{campaign.status === "completed" ? `${campaign.sent_count}/${campaign.recipient_count}` : campaign.status === "sending" ? "Отправляется" : "В очереди"}</span>
            </article>
          )) : <p className="muted">Отправок ещё не было.</p>}
        </div>
      </div>
    </section>
  );
}
