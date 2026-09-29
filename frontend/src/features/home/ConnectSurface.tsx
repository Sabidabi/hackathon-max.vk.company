import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Store } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { HOME_QUERY_KEY } from "../../api/me";
import { createRestaurant, type Restaurant } from "../../api/restaurants";
import { BrandLockup, Button, IconButton, TextInput } from "../../design";
import { haptics, useBackButton } from "../../max";
import { AccountShell } from "../auth/AccountShell";
import "./home.css";

const NAME_LIMIT = 200;

/**
 * «Подключить своё заведение» (P1-DOC-4 «Главная», `startapp=connect`): one field, then the
 * signed-in user becomes the venue's creator-admin and lands in its cabinet.
 */
function ConnectForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const trimmed = name.trim();
  const fieldError = touched && !trimmed ? "Укажите название" : trimmed.length > NAME_LIMIT ? `Не более ${NAME_LIMIT} символов` : null;
  const create = useMutation({
    mutationFn: () => createRestaurant({ name: trimmed, address: null, description: null }),
    onSuccess: (venue) => {
      haptics.notify("success");
      // The cabinet checks the point against this list: add it before navigating there.
      queryClient.setQueryData<Restaurant[]>(["restaurants"], (current) =>
        current && !current.some((item) => item.id === venue.id) ? [...current, venue] : current);
      void queryClient.invalidateQueries({ queryKey: ["restaurants"] });
      void queryClient.invalidateQueries({ queryKey: HOME_QUERY_KEY });
      navigate(`/manage/${venue.public_id}/menu`, { replace: true });
    },
    onError: () => haptics.notify("error"),
  });
  // React Router keeps the in-app history index in `history.state.idx`; opened by a deep link
  // there is nothing to go back to, so «Назад» leads Home.
  const goBack = () => {
    const index = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (index > 0) navigate(-1);
    else navigate("/", { replace: true });
  };
  useBackButton(goBack);

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (!trimmed || trimmed.length > NAME_LIMIT) return;
    create.mutate();
  }

  return (
    <main className="app-screen">
      <header className="app-screen__bar">
        <IconButton aria-label="Назад" icon={<ArrowLeft size={22} />} onClick={goBack} />
        <BrandLockup width={160} />
      </header>
      <form className="app-card connect-card" onSubmit={submit} noValidate>
        <span className="app-card__icon" aria-hidden="true"><Store size={28} /></span>
        <h1 className="app-screen__title">Подключить заведение</h1>
        <p className="app-screen__lead">Вы станете администратором. Адрес, меню и оформление добавите в кабинете.</p>
        <TextInput
          label="Название"
          required
          autoFocus
          autoComplete="organization"
          placeholder="Например, Кофейня Север"
          maxLength={NAME_LIMIT + 20}
          value={name}
          error={fieldError}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setTouched(true)}
        />
        {create.isError && <p className="app-card__error" role="alert">{create.error.message}</p>}
        <Button type="submit" fullWidth loading={create.isPending}>Создать заведение</Button>
      </form>
    </main>
  );
}

export default function ConnectSurface() {
  return (
    <AccountShell pendingLabel="Открываем подключение" startPayload="connect" frame="bare">
      <ConnectForm />
    </AccountShell>
  );
}
