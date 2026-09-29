import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, UserRound } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";

import {
  fetchAuthBootstrap,
  fetchCurrentUser,
  isAuthRejected,
  loginForDevelopment,
  loginWithMax,
  logout,
} from "../../api/auth";
import { fetchHealth } from "../../api/health";
import { useMaxLaunch } from "../../app/MaxLaunchProvider";
import { Help } from "../../components/Help";
import { BrandLockup, BrandMark } from "../../design/brand";
import { AuthError, LoadError, OpenInMax, Splash } from "../../design/screens";

/**
 * Signed-in frame shared by Home, the cabinet and invitations.
 * Signs in once per launch with MAX `initData` (or the development login when the
 * server allows it) and renders `children` only for an authenticated user.
 * Rights are still decided by the server on every request.
 */
export function AccountShell({
  children,
  pendingLabel = "Открываем кабинет",
  startPayload = null,
  frame = "cabinet",
}: {
  children: ReactNode;
  pendingLabel?: string;
  /** startapp payload for the «Откройте в MAX» deep link, e.g. `inv_<token>` or `manage_<id>`. */
  startPayload?: string | null;
  /**
   * `cabinet` — the legacy cabinet frame with the top bar; `bare` — children only, for screens
   * built on the design system (Home, invitation) that draw their own header.
   */
  frame?: "cabinet" | "bare";
}) {
  const { context: maxContext, resolved } = useMaxLaunch();
  const queryClient = useQueryClient();
  const loginStarted = useRef(false);
  const health = useQuery({
    queryKey: ["backend-health"],
    queryFn: fetchHealth,
    retry: 2,
    refetchInterval: 30_000,
    enabled: resolved,
  });
  const currentUser = useQuery({
    queryKey: ["current-user"],
    queryFn: fetchCurrentUser,
    retry: false,
    enabled: resolved,
    // Identity changes only through login/logout, which update this cache directly.
    // Without this, moving Home → cabinet would refetch and could sign in a second time.
    staleTime: Infinity,
  });
  const bootstrap = useQuery({
    queryKey: ["auth-bootstrap"],
    queryFn: fetchAuthBootstrap,
    retry: 1,
    enabled: resolved,
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
    if (!currentUser.isSuccess || currentUser.data !== null || !bootstrap.isSuccess || loginStarted.current) return;
    if (maxContext.available && maxContext.initData) {
      loginStarted.current = true;
      maxLogin.mutate(maxContext.initData);
      return;
    }
    if (bootstrap.data.development_auth) {
      loginStarted.current = true;
      devLogin.mutate();
    }
  }, [bootstrap.data, bootstrap.isSuccess, currentUser.data, currentUser.isSuccess, devLogin, maxContext, maxLogin]);

  if (!resolved) return <Splash label={pendingLabel} />;

  const loginError = maxLogin.error ?? devLogin.error;
  const isStarting = currentUser.isPending || bootstrap.isPending || maxLogin.isPending || devLogin.isPending;

  if (!currentUser.data) {
    if (isStarting) return <Splash label={pendingLabel} />;
    // 401/403: MAX data was rejected — only a fresh launch helps. Network/5xx: retry the login.
    if (loginError && isAuthRejected(loginError)) return <AuthError />;
    if (loginError) {
      return (
        <LoadError
          title="Не удалось войти"
          onRetry={() => {
            loginStarted.current = false;
            maxLogin.reset();
            devLogin.reset();
          }}
        >
          Сервер не ответил. Проверьте подключение и попробуйте снова.
        </LoadError>
      );
    }
    if (currentUser.isError || bootstrap.isError) {
      return (
        <LoadError
          title="Сервер недоступен"
          onRetry={() => {
            void currentUser.refetch();
            void bootstrap.refetch();
          }}
        >
          Проверьте подключение и попробуйте снова.
        </LoadError>
      );
    }
    // Signed-out outside MAX: no password or user-id login, only the way into MAX.
    if (!maxContext.available && !bootstrap.data?.development_auth) return <OpenInMax launchUrl={bootstrap.data?.max_launch_url} startPayload={startPayload} />;
    // Inside MAX (or with the development login) the login effect starts right after this render.
    return <Splash label={pendingLabel} />;
  }

  if (frame === "bare") return <>{children}</>;

  return (
    <main className="admin-shell">
      <header className="app-topbar">
        <Link className="app-brand" to={maxContext.available ? "/home" : "/"} aria-label="Синица — на главную">
          <BrandLockup width={160} className="app-brand-lockup" />
          <BrandMark size={32} className="app-brand-mark" />
        </Link>
        <div className="header-actions">
          <Help label="Состояние подключения">{health.isError ? "Нет связи с сервером" : "Сервер подключён"}. {maxContext.available ? "Открыто в MAX." : "Веб-кабинет."}</Help>
          <span className="account-label"><UserRound size={16} />{currentUser.data.display_name}</span>
          <button className="icon-button" aria-label="Выйти" onClick={() => logoutMutation.mutate()} disabled={logoutMutation.isPending}><LogOut size={17} /></button>
        </div>
      </header>
      {children}
    </main>
  );
}
