import { Copy, House, LifeBuoy, RotateCcw, SearchX, ShieldAlert, WifiOff } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { openMaxLink } from "../../max";
import { share } from "../../max/platform";
import { BrandLockup, BrandMark } from "../brand";
import { Button, ButtonLink, QrCode } from "../components";
import "./screens.css";

/** How long the splash may stay before it turns into an error with «Попробовать снова». */
export const SPLASH_TIMEOUT_MS = 8_000;

function reloadApp() {
  window.location.reload();
}

function useSupportLink(enabled: boolean) {
  const [link, setLink] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    fetch("/api/v1/auth/bootstrap", { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => data?.support_link && setLink(data.support_link))
      .catch(() => {});
  }, [enabled]);
  return link;
}

function ServiceMessage({ icon, title, children, actions, tone = "neutral", showSupportButton = false }: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  tone?: "neutral" | "danger";
  showSupportButton?: boolean;
}) {
  const supportLink = useSupportLink(showSupportButton);
  return (
    <main className="s-service">
      <section className={`s-service__message s-service__message--${tone}`} aria-labelledby="service-title">
        <span className="s-service__icon" aria-hidden="true">{icon}</span>
        <h1 id="service-title" className="s-service__title">{title}</h1>
        {children && <p className="s-service__text">{children}</p>}
        {actions && <div className="s-service__actions">{actions}</div>}
        {supportLink && (
          <div className="s-service__actions">
            <Button
              variant="secondary"
              icon={<LifeBuoy size={20} />}
              onClick={() => openMaxLink(supportLink)}
            >
              Написать в поддержку
            </Button>
          </div>
        )}
      </section>
    </main>
  );
}

/** Server or network failure with a retry that does not reload more than needed. */
export function LoadError({ title = "Не удалось загрузить приложение", children, onRetry = reloadApp }: {
  title?: string;
  children?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <ServiceMessage
      icon={<WifiOff size={28} />}
      title={title}
      tone="danger"
      showSupportButton
      actions={<Button icon={<RotateCcw size={20} />} onClick={onRetry}>Попробовать снова</Button>}
    >
      {children ?? "Проверьте интернет и попробуйте снова."}
    </ServiceMessage>
  );
}

/**
 * Launch splash: the «Синица» icon while MAX data, the session or a screen chunk loads.
 * It adds no delay of its own (it disappears as soon as content is ready, normally < 1.5 s)
 * and has no endless spinner: after {@link SPLASH_TIMEOUT_MS} it becomes {@link LoadError}.
 */
export function Splash({ label = "Открываем приложение", timeoutMs = SPLASH_TIMEOUT_MS, onRetry }: {
  label?: string;
  timeoutMs?: number;
  onRetry?: () => void;
}) {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setTimedOut(true), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [timeoutMs]);
  if (timedOut) return <LoadError onRetry={onRetry} />;
  return (
    <main className="s-service s-service--splash" aria-busy="true">
      <BrandMark size={88} className="s-splash__mark" />
      <p className="s-visually-hidden" role="status">{label}</p>
    </main>
  );
}

/** MAX rejected the signed launch data (401): no session, one clear way out. */
export function AuthError({ onRestart = reloadApp }: { onRestart?: () => void }) {
  return (
    <ServiceMessage
      icon={<ShieldAlert size={28} />}
      title="Не удалось подтвердить вход"
      tone="danger"
      showSupportButton
      actions={<Button icon={<RotateCcw size={20} />} onClick={onRestart}>Перезапустить</Button>}
    >
      MAX не подтвердил запуск. Перезапустите мини-приложение или откройте его снова из чата с ботом.
    </ServiceMessage>
  );
}

/** Unknown address. */
export function NotFound() {
  return (
    <ServiceMessage
      icon={<SearchX size={28} />}
      title="Страница не найдена"
      actions={<Link className="s-button s-button--primary" to="/"><House size={20} aria-hidden="true" />На главную</Link>}
    >
      Проверьте ссылку или начните с главной.
    </ServiceMessage>
  );
}

/** Adds `startapp=<payload>` to the bot deep link from `/auth/bootstrap`. */
export function maxDeepLink(launchUrl: string | null | undefined, startPayload?: string | null): string | null {
  if (!launchUrl) return null;
  try {
    const url = new URL(launchUrl);
    if (startPayload) url.searchParams.set("startapp", startPayload);
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Outside MAX, for anything that needs a signed-in user: a deep link into the mini app, a QR of this page for the phone and link copying.
 * No password, e-mail or user-id login is offered.
 */
export function OpenInMax({ launchUrl, startPayload, title = "Откройте в MAX", children }: {
  /** `max_launch_url` from `/auth/bootstrap`; null when the bot is not configured. */
  launchUrl: string | null | undefined;
  startPayload?: string | null;
  title?: string;
  children?: ReactNode;
}) {
  const deepLink = maxDeepLink(launchUrl, startPayload);
  // Without the hash: it may carry MAX launch data (#WebAppData=…) that must not leak into a QR.
  const pageUrl = typeof window === "undefined" ? "" : `${window.location.origin}${window.location.pathname}${window.location.search}`;
  return (
    <main className="s-service s-service--open">
      <div className="s-open">
        <header className="s-open__brand"><BrandLockup width={160} /></header>
        <section className="s-open__main" aria-labelledby="open-in-max-title">
          <h1 id="open-in-max-title" className="s-service__title">{title}</h1>
          <p className="s-service__text">
            {children ?? "Кабинет работает внутри мини-приложения MAX. Вход — через ваш аккаунт MAX, без паролей."}
          </p>
          <div className="s-service__actions s-open__actions">
            {deepLink ? (
              <ButtonLink href={deepLink} rel="noopener">Открыть в MAX</ButtonLink>
            ) : (
              <p className="s-open__notice" role="note">Ссылка на бота MAX не настроена на сервере. Откройте мини-приложение из чата с ботом заведения.</p>
            )}
            <Button
              variant="secondary"
              icon={<Copy size={20} />}
              onClick={() => void share({ link: deepLink ?? pageUrl })}
            >
              Скопировать ссылку
            </Button>
          </div>
        </section>
        {pageUrl && (
          <figure className="s-open__qr">
            <QrCode value={pageUrl} size={184} label="QR-код этой страницы" />
            <figcaption>Наведите камеру телефона, чтобы открыть эту страницу там</figcaption>
          </figure>
        )}
      </div>
    </main>
  );
}
