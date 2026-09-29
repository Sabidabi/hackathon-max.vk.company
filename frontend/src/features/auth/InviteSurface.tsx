import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, House, LinkIcon, RotateCcw, ShieldAlert, UserCheck, UserPlus } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { HOME_QUERY_KEY } from "../../api/me";
import { listRestaurants, type Restaurant } from "../../api/restaurants";
import { acceptInvite, previewInvite, TeamRequestError, type InvitePreview } from "../../api/team";
import { BrandMark, Button, showToast, Skeleton } from "../../design";
import { haptics } from "../../max";
import { AccountShell } from "./AccountShell";
import "./invite.css";

const INVITE_TOKEN = /^[A-Za-z0-9_-]{30,128}$/;
const expiryFormat = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

type Problem = { icon: ReactNode; title: string; text: string; retry?: boolean };

/** One message per failure the server can answer with (P1-DOC-4 «Приглашение ссылкой»). */
function inviteProblem(error: unknown): Problem {
  const status = error instanceof TeamRequestError ? error.status : 0;
  if (status === 404 || status === 410 || status === 422) {
    return { icon: <LinkIcon size={28} />, title: "Приглашение недействительно", text: "Ссылка уже использована, отозвана или истекла. Попросите администратора прислать новую." };
  }
  if (status === 403) {
    return { icon: <ShieldAlert size={28} />, title: "Приглашение для другого аккаунта", text: "Эта ссылка выдана другому пользователю MAX. Попросите администратора прислать ссылку вам." };
  }
  if (status === 429) {
    return { icon: <Clock size={28} />, title: "Слишком много попыток", text: "Подождите немного и попробуйте снова.", retry: true };
  }
  return { icon: <RotateCcw size={28} />, title: "Не удалось открыть приглашение", text: error instanceof Error ? error.message : "Проверьте подключение и попробуйте снова.", retry: true };
}

function InviteCard({ icon, tone = "neutral", title, children, actions }: {
  icon: ReactNode;
  tone?: "neutral" | "danger" | "success";
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <main className="invite-screen">
      <header className="invite-screen__brand"><BrandMark size={40} /></header>
      <section className={`invite-card invite-card--${tone} invite-card--enter`} aria-labelledby="invite-title">
        <span className="invite-card__icon" aria-hidden="true">{icon}</span>
        <h1 id="invite-title" className="invite-card__title">{title}</h1>
        {children}
        {actions && <div className="invite-card__actions">{actions}</div>}
      </section>
    </main>
  );
}

function findVenue(list: Restaurant[], name: string, known: Set<string> = new Set()): Restaurant | undefined {
  return list.find((item) => !known.has(item.id) && item.name === name)
    ?? list.find((item) => !known.has(item.id))
    ?? list.find((item) => item.name === name);
}

function InviteAcceptance({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const preview = useQuery({
    queryKey: ["invite-preview", token],
    queryFn: () => previewInvite(token),
    retry: false,
    staleTime: Infinity,
  });

  async function openCabinet(invite: InvitePreview, known?: Set<string>) {
    const list = await queryClient.fetchQuery({ queryKey: ["restaurants"], queryFn: listRestaurants, staleTime: 0 });
    const venue = findVenue(list, invite.restaurant_name, known);
    navigate(venue ? `/manage/${venue.public_id}` : "/manage", { replace: true });
  }

  const accept = useMutation({
    mutationFn: async (invite: InvitePreview) => {
      // Remember the venues we already manage to recognise the new one after acceptance.
      const before = await listRestaurants().catch(() => [] as Restaurant[]);
      await acceptInvite(token);
      return { invite, known: new Set(before.map((item) => item.id)) };
    },
    onSuccess: async ({ invite, known }) => {
      haptics.notify("success");
      void queryClient.invalidateQueries({ queryKey: HOME_QUERY_KEY });
      showToast(`Вы администратор «${invite.restaurant_name}»`);
      await openCabinet(invite, known).catch(() => navigate("/manage", { replace: true }));
    },
    onError: () => haptics.notify("error"),
  });
  const goHome = () => {
    haptics.selection();
    navigate("/", { replace: true });
  };

  if (preview.isPending) {
    return (
      <main className="invite-screen" aria-busy="true">
        <header className="invite-screen__brand"><BrandMark size={40} /></header>
        <section className="invite-card">
          <Skeleton width={64} height={64} radius="card" />
          <Skeleton width="80%" height={28} />
          <Skeleton width="60%" />
          <Skeleton height={48} radius="control" />
        </section>
        <p className="s-visually-hidden" role="status">Открываем приглашение</p>
      </main>
    );
  }

  if (preview.isError) {
    const problem = inviteProblem(preview.error);
    return (
      <InviteCard
        icon={problem.icon}
        tone="danger"
        title={problem.title}
        actions={<>
          {problem.retry && <Button icon={<RotateCcw size={20} />} fullWidth onClick={() => void preview.refetch()}>Попробовать снова</Button>}
          <Button variant={problem.retry ? "ghost" : "primary"} icon={<House size={20} />} fullWidth onClick={goHome}>На главную</Button>
        </>}
      >
        <p className="invite-card__text">{problem.text}</p>
      </InviteCard>
    );
  }

  const invite = preview.data;
  const alreadyAdmin = invite.already_admin
    || (accept.error instanceof TeamRequestError && accept.error.status === 409);

  if (alreadyAdmin) {
    return (
      <InviteCard
        icon={<UserCheck size={28} />}
        tone="success"
        title={<>Вы уже администратор «{invite.restaurant_name}»</>}
        actions={<>
          <Button fullWidth onClick={() => void openCabinet(invite).catch(() => navigate("/manage"))}>Открыть кабинет</Button>
          <Button variant="ghost" fullWidth onClick={goHome}>На главную</Button>
        </>}
      >
        <p className="invite-card__text">Ссылка осталась действующей — её можно переслать тому, кого пригласили.</p>
      </InviteCard>
    );
  }

  const acceptProblem = accept.isError ? inviteProblem(accept.error) : null;
  return (
    <InviteCard
      icon={<UserPlus size={28} />}
      title={<>Вас приглашают администратором «{invite.restaurant_name}»</>}
      actions={<>
        <Button fullWidth loading={accept.isPending} onClick={() => { haptics.impact("light"); accept.mutate(invite); }}>Принять</Button>
        <Button variant="ghost" fullWidth disabled={accept.isPending} onClick={goHome}>Не сейчас</Button>
      </>}
    >
      <dl className="invite-card__facts">
        {invite.invited_by && <div><dt>Пригласил</dt><dd>{invite.invited_by}</dd></div>}
        <div><dt>Действует до</dt><dd>{expiryFormat.format(new Date(invite.expires_at))}</dd></div>
      </dl>
      <p className="invite-card__text">Администратор управляет меню, оформлением, QR-кодом и командой заведения.</p>
      {acceptProblem && (
        <p className="invite-card__error" role="alert"><strong>{acceptProblem.title}.</strong> {acceptProblem.text}</p>
      )}
    </InviteCard>
  );
}

/** `/invite/:token` and `startapp=inv_<token>`: preview, then «Принять» or «Не сейчас». */
export default function InviteSurface() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const valid = INVITE_TOKEN.test(token);
  return (
    <AccountShell pendingLabel="Открываем приглашение" startPayload={valid ? `inv_${token}` : null} frame="bare">
      {valid ? <InviteAcceptance token={token} /> : (
        <InviteCard
          icon={<LinkIcon size={28} />}
          tone="danger"
          title="Приглашение недействительно"
          actions={<Button icon={<House size={20} />} fullWidth onClick={() => navigate("/", { replace: true })}>На главную</Button>}
        >
          <p className="invite-card__text">Ссылка повреждена. Попросите администратора прислать новую.</p>
        </InviteCard>
      )}
    </AccountShell>
  );
}
