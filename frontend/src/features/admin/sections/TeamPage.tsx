import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Crown, Link2, LogOut, Share2, UserMinus, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { fetchCurrentUser } from "../../../api/auth";
import { createInvite, leaveVenue, listInvites, listMembers, removeMember, revokeInvite, type CreatedInvite, type TeamMember } from "../../../api/team";
import { Button, EmptyState, IconButton, Sheet, Skeleton } from "../../../design";
import { showToast } from "../../../design/toast";
import { haptics, share } from "../../../max";

const timeFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const inviteLink = (invite: CreatedInvite) => invite.max_deep_link ?? invite.web_url;

/**
 * «Администраторы» (P1-DOC-4 «Приглашение», «Много администраторов»): equal admins, the
 * creator is marked and cannot be removed; «Пригласить» creates a one-time link for 24 h and
 * shares it through MAX (or copies it). Removing and leaving ask for a confirmation.
 */
export function TeamPage({ pointId, venueName }: { pointId: string; venueName: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [fresh, setFresh] = useState<CreatedInvite | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: "remove"; member: TeamMember } | { kind: "leave" }>(null);
  const me = useQuery({ queryKey: ["current-user"], queryFn: fetchCurrentUser, staleTime: Infinity });
  const members = useQuery({ queryKey: ["team-members", pointId], queryFn: () => listMembers(pointId) });
  const invites = useQuery({ queryKey: ["team-invites", pointId], queryFn: () => listInvites(pointId) });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["team-members", pointId] });
    void client.invalidateQueries({ queryKey: ["team-invites", pointId] });
  };
  // A link lives only if it was sent: a closed share sheet withdraws the fresh invite.
  const discard = async (value: CreatedInvite, message: string) => {
    setFresh((current) => (current?.id === value.id ? null : current));
    await revokeInvite(pointId, value.id).catch(() => undefined);
    refresh();
    showToast(message);
  };
  const shareInvite = async (value: CreatedInvite) => {
    const result = await share({ text: `Приглашаю администратором «${venueName}» в Синице`, link: inviteLink(value) });
    if (result === "cancelled") await discard(value, "Приглашение не отправлено");
  };
  const invite = useMutation({
    mutationFn: () => createInvite(pointId),
    onSuccess: (value) => {
      haptics.notify("success");
      setFresh(value);
      refresh();
      void shareInvite(value);
    },
    onError: () => haptics.notify("error"),
  });
  const remove = useMutation({
    mutationFn: (member: TeamMember) => removeMember(pointId, member.user_id),
    onSuccess: (_, member) => {
      setConfirm(null);
      refresh();
      showToast(`${member.display_name} больше не администратор`);
    },
  });
  const revoke = useMutation({ mutationFn: (inviteId: string) => revokeInvite(pointId, inviteId), onSuccess: () => { refresh(); showToast("Приглашение отозвано"); } });
  const leave = useMutation({
    mutationFn: () => leaveVenue(pointId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["restaurants"] });
      void client.invalidateQueries({ queryKey: ["me-home"] });
      navigate("/", { replace: true });
    },
  });
  const myId = me.data?.id;
  const now = new Date();
  const pending = invites.data?.filter((item) => item.id !== fresh?.id && !item.accepted_at && !item.revoked_at && new Date(item.expires_at) > now) ?? [];
  const error = invite.error ?? revoke.error;

  return (
    <div className="more-page">
      <Button icon={<UserPlus size={20} />} loading={invite.isPending} onClick={() => { setFresh(null); invite.mutate(); }} fullWidth>Пригласить администратора</Button>
      <p className="cabinet-muted">Все администраторы равны: меню, оформление, QR и команда. Ссылка одноразовая, действует сутки.</p>
      {fresh && (
        <div className="team-fresh" role="status">
          <Link2 size={18} aria-hidden="true" />
          <span className="team-fresh__link">{inviteLink(fresh)}</span>
          <Button variant="ghost" icon={<Share2 size={18} />} onClick={() => void shareInvite(fresh)}>Отправить</Button>
          <IconButton aria-label="Отменить приглашение" icon={<X size={20} />} onClick={() => void discard(fresh, "Приглашение отменено")} />
        </div>
      )}
      {error && <p className="cabinet-error" role="alert">{error.message}</p>}

      <section aria-labelledby="team-members-title" className="more-block">
        <h2 id="team-members-title">Команда</h2>
        {members.isPending && <div className="more-skeleton">{[0, 1].map((row) => <Skeleton key={row} height={56} radius="control" />)}</div>}
        {members.isError && <EmptyState icon={<AlertTriangle size={28} />} tone="danger" title="Команда не загрузилась" action={<Button variant="secondary" onClick={() => members.refetch()}>Повторить</Button>}>{members.error.message}</EmptyState>}
        {members.data && (
          <ul className="cabinet-list">
            {members.data.map((member) => (
              <li key={member.user_id}>
                <div className="cabinet-list__row cabinet-list__row--static">
                  <span className="cabinet-list__icon" aria-hidden="true">{member.is_creator ? <Crown size={20} /> : member.display_name.slice(0, 1).toUpperCase()}</span>
                  <span className="cabinet-list__text">
                    <strong>{member.display_name}{member.user_id === myId ? " · вы" : ""}</strong>
                    <small>{member.is_creator ? "Создатель — удалить нельзя" : "Администратор"}</small>
                  </span>
                  {!member.is_creator && member.user_id !== myId && (
                    <IconButton aria-label={`Удалить ${member.display_name} из администраторов`} icon={<UserMinus size={20} />} onClick={() => setConfirm({ kind: "remove", member })} />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {pending.length > 0 && (
        <section aria-labelledby="team-pending-title" className="more-block">
          <h2 id="team-pending-title">Ждут принятия</h2>
          <ul className="cabinet-list">
            {pending.map((item) => (
              <li key={item.id}>
                <div className="cabinet-list__row cabinet-list__row--static">
                  <span className="cabinet-list__icon" aria-hidden="true"><Link2 size={20} /></span>
                  <span className="cabinet-list__text">
                    <strong>Ссылка-приглашение</strong>
                    <small>до {timeFormat.format(new Date(item.expires_at))}{item.invited_by ? ` · ${item.invited_by}` : ""}</small>
                  </span>
                  <IconButton aria-label="Отозвать приглашение" icon={<X size={20} />} disabled={revoke.isPending} onClick={() => revoke.mutate(item.id)} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Button variant="ghost" icon={<LogOut size={18} />} onClick={() => setConfirm({ kind: "leave" })}>Выйти из заведения</Button>
      {leave.isError && <p className="cabinet-error" role="alert">{leave.error.message}</p>}

      <Sheet
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "remove" ? `Удалить ${confirm.member.display_name}?` : `Выйти из «${venueName}»?`}
        footer={confirm?.kind === "remove"
          ? <Button variant="danger" fullWidth loading={remove.isPending} onClick={() => remove.mutate(confirm.member)}>Удалить из администраторов</Button>
          : <Button variant="danger" fullWidth loading={leave.isPending} onClick={() => { setConfirm(null); leave.mutate(); }}>Выйти</Button>}
      >
        <p className="cabinet-muted">
          {confirm?.kind === "remove"
            ? "Доступ к кабинету пропадёт сразу. Вернуть можно новым приглашением."
            : "Вернуться можно только по новому приглашению."}
        </p>
        {remove.isError && <p className="cabinet-error" role="alert">{remove.error.message}</p>}
      </Sheet>
    </div>
  );
}
