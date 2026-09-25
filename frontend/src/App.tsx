import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Coffee, LoaderCircle, LogOut, UserRound } from "lucide-react";
import { Help } from "./components/Help";
import { useEffect, useRef, useState } from "react";

import {
  fetchCurrentUser,
  fetchAuthBootstrap,
  loginForDevelopment,
  loginWithMax,
  logout,
} from "./api/auth";
import { fetchHealth } from "./api/health";
import { RestaurantCabinet } from "./features/restaurants/RestaurantCabinet";
import { PublicMenu } from "./features/public/PublicMenu";
import { initializeMaxBridge, readMaxContext, waitForMaxBridge, type MaxContext } from "./max/bridge";

function OwnerApp({ maxContext }: { maxContext: MaxContext }) {
  const queryClient = useQueryClient();
  const maxLoginStarted = useRef(false);
  const health = useQuery({
    queryKey: ["backend-health"],
    queryFn: fetchHealth,
    retry: 2,
    refetchInterval: 30_000,
  });
  const currentUser = useQuery({
    queryKey: ["current-user"],
    queryFn: fetchCurrentUser,
    retry: false,
  });
  const bootstrap = useQuery({
    queryKey: ["auth-bootstrap"],
    queryFn: fetchAuthBootstrap,
    retry: 1,
  });
  const maxLogin = useMutation({
    mutationFn: loginWithMax,
    onSuccess: (user) => queryClient.setQueryData(["current-user"], user),
  });
  const devLogin = useMutation({
    mutationFn: loginForDevelopment,
    onSuccess: (user) => queryClient.setQueryData(["current-user"], user),
  });
  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.clear();
      queryClient.setQueryData(["current-user"], null);
      queryClient.removeQueries({ queryKey: ["restaurants"] });
      queryClient.removeQueries({ queryKey: ["imports"] });
    },
  });

  useEffect(() => {
    if (!currentUser.isSuccess || currentUser.data !== null || !bootstrap.isSuccess || maxLoginStarted.current) return;
    if (maxContext.available && maxContext.initData) {
      maxLoginStarted.current = true;
      maxLogin.mutate(maxContext.initData);
      return;
    }
    if (bootstrap.data.development_auth) {
      maxLoginStarted.current = true;
      devLogin.mutate();
    }
  }, [bootstrap.data, bootstrap.isSuccess, currentUser.data, currentUser.isSuccess, devLogin, maxLogin]);

  const loginError = maxLogin.error ?? devLogin.error;
  const isStarting = currentUser.isPending || bootstrap.isPending || maxLogin.isPending || devLogin.isPending;

  return <main className="admin-shell">
    <header className="app-topbar"><a className="app-brand" href="/"><span><Coffee size={21} /></span>меню<span className="brand-channel">MAX</span></a><div className="header-actions"><Help label="Состояние подключения">{health.isError ? "Нет связи с сервером" : "Сервер подключён"}. {maxContext.available ? "Открыто в MAX." : "Веб-кабинет."}</Help>{currentUser.data && <><span className="account-label"><UserRound size={16} />{currentUser.data.display_name}</span><button className="icon-button" aria-label="Выйти" onClick={() => logoutMutation.mutate()} disabled={logoutMutation.isPending}><LogOut size={17} /></button></>}</div></header>
    {currentUser.data ? <RestaurantCabinet /> : <section className="launch-state" aria-live="polite">
    {isStarting ? <><LoaderCircle className="launch-spinner" size={28} /><strong>Открываем кабинет</strong></> : currentUser.isError || bootstrap.isError || health.isError ? <><strong>Сервер недоступен</strong><span>Проверьте подключение и повторите запуск.</span></> : <><Coffee size={30} strokeWidth={1.5} /><strong>{loginError ? "Не удалось подтвердить вход" : "Нет данных для входа"}</strong><span>{loginError?.message ?? "Откройте мини-приложение через бота MAX или перезапустите его."}</span>{bootstrap.data?.max_launch_url && <a className="primary-link" href={bootstrap.data.max_launch_url}>Открыть бота MAX</a>}</>}
    </section>}
  </main>;

}

export default function App() {
  const [maxContext, setMaxContext] = useState<MaxContext | null>(() => {
    const context = initializeMaxBridge();
    return context.available ? context : null;
  });
  useEffect(() => {
    if (maxContext) return;
    let active = true;
    void waitForMaxBridge().then((context) => {
      if (active) setMaxContext(context);
    });
    return () => { active = false; };
  }, [maxContext]);

  const publicMatch = window.location.pathname.match(/^\/r\/([a-zA-Z0-9_-]+)\/?$/);
  const maxRestaurantId = maxContext?.startParam?.match(/^r_([a-zA-Z0-9_-]+)$/)?.[1];
  const publicId = publicMatch?.[1] ?? maxRestaurantId;
  if (publicId) {
    return <PublicMenu publicId={publicId} maxContext={maxContext ?? readMaxContext()} />;
  }
  if (!maxContext) {
    return <main className="launch-state" aria-live="polite"><LoaderCircle className="launch-spinner" size={28} /><strong>Открываем приложение</strong></main>;
  }
  return <OwnerApp maxContext={maxContext} />;
}
