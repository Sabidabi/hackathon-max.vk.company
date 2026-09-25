import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { changeRole, createInvite, listInvites, listMembers, removeMember, revokeInvite, type TeamInvite } from "../../api/team";
import { Help } from "../../components/Help";

export function TeamPanel({ restaurantId }: { restaurantId: string }) {
  const client = useQueryClient();
  const [maxId, setMaxId] = useState("");
  const [role, setRole] = useState<"manager" | "editor">("editor");
  const [freshInvite, setFreshInvite] = useState<TeamInvite | null>(null);
  const members = useQuery({ queryKey: ["team-members", restaurantId], queryFn: () => listMembers(restaurantId) });
  const invites = useQuery({ queryKey: ["team-invites", restaurantId], queryFn: () => listInvites(restaurantId) });
  const refresh = () => { void client.invalidateQueries({ queryKey: ["team-members", restaurantId] }); void client.invalidateQueries({ queryKey: ["team-invites", restaurantId] }); };
  const invite = useMutation({ mutationFn: () => createInvite(restaurantId, Number(maxId), role), onSuccess: (value) => { setFreshInvite(value); setMaxId(""); refresh(); } });
  const update = useMutation({ mutationFn: ({ userId, nextRole }: { userId: string; nextRole: "manager" | "editor" }) => changeRole(restaurantId, userId, nextRole), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (userId: string) => removeMember(restaurantId, userId), onSuccess: refresh });
  const revoke = useMutation({ mutationFn: (inviteId: string) => revokeInvite(restaurantId, inviteId), onSuccess: refresh });
  const error = invite.error ?? update.error ?? remove.error ?? revoke.error;

  return <section className="profile-card team-panel">
    <div className="subsection-heading"><h2>Команда точки</h2><Help label="Как пригласить сотрудника">Попросите сотрудника открыть бота и отправить /id. Приглашение действует сутки и подходит только указанному MAX ID.</Help></div>
    <form className="team-invite-form" onSubmit={(event) => { event.preventDefault(); setFreshInvite(null); invite.mutate(); }}>
      <label>MAX ID сотрудника<input type="number" min="1" required value={maxId} onChange={(event) => setMaxId(event.target.value)} placeholder="Числовой ID" /></label>
      <label>Доступ<select value={role} onChange={(event) => setRole(event.target.value as "manager" | "editor")}><option value="editor">Редактор меню</option><option value="manager">Управляющий</option></select></label>
      <button type="submit" disabled={invite.isPending || !maxId}>Пригласить</button>
    </form>
    {freshInvite?.invite_url && <div className="team-invite-link"><span>Передайте ссылку сотруднику:</span><a href={freshInvite.invite_url}>{freshInvite.invite_url}</a><button type="button" className="button-quiet" onClick={() => navigator.clipboard.writeText(freshInvite.invite_url!)}>Копировать</button></div>}
    {error && <p className="form-error" role="alert">{error.message}</p>}
    <h3>Доступ к точке</h3>
    {members.isPending && <p>Загружаем…</p>}{members.isError && <p className="form-error">{members.error.message}</p>}
    {members.data?.map((member) => <div className="team-row" key={member.user_id}><span><strong>{member.display_name}</strong><small>MAX ID {member.max_user_id}</small></span>{member.role === "owner" ? <span>Владелец</span> : <><select aria-label={`Роль ${member.display_name}`} value={member.role} disabled={update.isPending} onChange={(event) => update.mutate({ userId: member.user_id, nextRole: event.target.value as "manager" | "editor" })}><option value="editor">Редактор</option><option value="manager">Управляющий</option></select><button type="button" className="button-quiet" disabled={remove.isPending} onClick={() => { if (window.confirm(`Убрать доступ у ${member.display_name}?`)) remove.mutate(member.user_id); }}>Убрать</button></>}</div>)}
    {invites.data?.some((item) => !item.accepted_at && !item.revoked_at && new Date(item.expires_at) > new Date()) && <><h3>Ожидают принятия</h3>{invites.data.filter((item) => !item.accepted_at && !item.revoked_at && new Date(item.expires_at) > new Date()).map((item) => <div className="team-row" key={item.id}><span>MAX ID {item.max_user_id} · {item.role === "manager" ? "Управляющий" : "Редактор"}</span><button type="button" className="button-quiet" disabled={revoke.isPending} onClick={() => revoke.mutate(item.id)}>Отозвать</button></div>)}</>}
  </section>;
}
