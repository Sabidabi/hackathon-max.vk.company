import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing, MessageCircle } from "lucide-react";

import { IconButton } from "../../design";
import { showToast } from "../../design/toast";
import { haptics, openMaxLink } from "../../max";
import { fetchChatLink, fetchItemSubscription, setItemSubscription } from "./api";
import "./notifications.css";

/**
 * «Написать в кофейню» (P1-TASK-64): opens the bot dialog with this point
 * (`/start chat_<public_id>`); hidden when the bot is not configured.
 */
export function WriteToPointButton({ publicId }: { publicId: string }) {
  const link = useQuery({ queryKey: ["point-chat-link", publicId], queryFn: () => fetchChatLink(publicId), staleTime: Infinity, retry: false });
  const url = link.data?.url;
  if (!url) return null;
  return (
    <IconButton
      variant="tonal"
      aria-label="Написать в кофейню"
      icon={<MessageCircle size={20} />}
      onClick={() => { haptics.selection(); openMaxLink(url); }}
    />
  );
}

/**
 * «Сообщить, когда появится» on an unavailable position (P1-DOC-11 Г1): one message when it
 * is back at this point. Signed-in guests only; the server keeps the consent.
 */
export function NotifyWhenBackButton({ publicId, itemKey, enabled }: { publicId: string; itemKey: string | null | undefined; enabled: boolean }) {
  const client = useQueryClient();
  const key = ["item-subscription", publicId, itemKey];
  const state = useQuery({
    queryKey: key,
    queryFn: () => fetchItemSubscription(publicId, itemKey as string),
    enabled: enabled && Boolean(itemKey),
    retry: false,
  });
  const toggle = useMutation({
    mutationFn: (subscribed: boolean) => setItemSubscription(publicId, itemKey as string, subscribed),
    onSuccess: (result) => {
      client.setQueryData(key, result);
      haptics.notify("success");
      showToast(result.subscribed ? "Сообщим в MAX, когда появится" : "Не будем сообщать", { tone: "success" });
    },
    onError: (error) => showToast(error.message, { tone: "danger" }),
  });
  if (!enabled || !itemKey || !state.data) return null;
  const subscribed = state.data.subscribed;
  return (
    <button
      type="button"
      className="nt-notify"
      aria-pressed={subscribed}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate(!subscribed)}
    >
      {subscribed ? <BellRing size={18} aria-hidden="true" /> : <Bell size={18} aria-hidden="true" />}
      {subscribed ? "Сообщим, когда появится" : "Сообщить, когда появится"}
    </button>
  );
}
