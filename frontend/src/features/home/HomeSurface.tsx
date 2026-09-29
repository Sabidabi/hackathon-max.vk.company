import { useQuery } from "@tanstack/react-query";
import { Bell, ChevronRight, Clock, QrCode, RotateCcw, ScanLine, Sparkles, Star, Store } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { fetchHome, HOME_QUERY_KEY, type HomeAdminVenue, type HomeData, type HomeVenue } from "../../api/me";
import { BrandLockup, Button, EmptyState, showToast, Skeleton } from "../../design";
import { canScanQr, haptics, scanQr, scannedTargetPath } from "../../max";
import { AccountShell } from "../auth/AccountShell";
import "./home.css";

function Section({ id, icon, title, children }: { id: string; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="home-section" aria-labelledby={id}>
      <h2 id={id} className="home-section__title"><span aria-hidden="true">{icon}</span>{title}</h2>
      {children}
    </section>
  );
}

function VenueRows<T extends HomeVenue>({ venues, icon, end }: { venues: T[]; icon: ReactNode; end?: (venue: T) => ReactNode }) {
  return (
    <ul className="home-list">
      {venues.map((venue) => (
        <li key={venue.public_id}>
          <Link className="home-row" to={`/r/${venue.public_id}`} onClick={() => haptics.selection()}>
            <span className="home-row__icon" aria-hidden="true">{icon}</span>
            <span className="home-row__text">
              <span className="home-row__name">{venue.name}</span>
              {venue.address && <span className="home-row__meta">{venue.address}</span>}
            </span>
            <span className="home-row__end">{end?.(venue)}<ChevronRight size={18} aria-hidden="true" /></span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function AdminVenueCard({ venue }: { venue: HomeAdminVenue }) {
  return (
    <li>
      <Link className="home-venue" to={`/manage/${venue.public_id}`} aria-label={`Кабинет «${venue.name}»`} onClick={() => haptics.selection()}>
        <span className="home-venue__icon" aria-hidden="true"><Store size={24} /></span>
        <span className="home-venue__text">
          <span className="home-venue__name">{venue.name}</span>
          <span className={`home-venue__status${venue.has_published_menu ? " home-venue__status--live" : ""}`}>
            {venue.has_published_menu ? "Меню опубликовано" : "Меню не опубликовано"}
          </span>
          {venue.unpublished_changes > 0 && (
            <span className="home-venue__badge">Не опубликовано: {venue.unpublished_changes}</span>
          )}
        </span>
        <ChevronRight className="home-venue__chevron" size={20} aria-hidden="true" />
      </Link>
    </li>
  );
}

function HomeSkeleton() {
  return (
    <main className="app-screen" aria-busy="true">
      <header className="app-screen__bar"><BrandLockup width={160} /></header>
      <div className="home-skeleton">
        <Skeleton width="70%" height={32} />
        <Skeleton height={48} radius="control" />
        <Skeleton height={64} radius="card" />
        <Skeleton height={64} radius="card" />
      </div>
      <p className="s-visually-hidden" role="status">Загружаем главную</p>
    </main>
  );
}

function HomeContent({ home }: { home: HomeData }) {
  const navigate = useNavigate();
  const [scanning, setScanning] = useState(false);
  const scannerAvailable = canScanQr();
  const isEmpty = !home.admin_venues.length && !home.recent.length && !home.favorites.length;

  async function scan() {
    haptics.impact("light");
    setScanning(true);
    try {
      const text = await scanQr();
      if (text === null) return; // cancelled or unsupported: nothing to report
      const path = scannedTargetPath(text, window.location.origin);
      if (path) {
        haptics.notify("success");
        navigate(path);
      } else {
        haptics.notify("error");
        showToast("Это не QR меню. Наведите камеру на QR заведения.");
      }
    } finally {
      setScanning(false);
    }
  }

  return (
    <main className="app-screen home-enter">
      <header className="app-screen__bar"><BrandLockup width={160} /></header>
      <section className="home-hero" aria-labelledby="home-title">
        <h1 id="home-title" className="app-screen__title">
          {home.first_name ? `Здравствуйте, ${home.first_name}` : "Здравствуйте"}
        </h1>
        <Button
          fullWidth
          icon={<ScanLine size={22} />}
          loading={scanning}
          disabled={!scannerAvailable}
          aria-describedby={scannerAvailable ? undefined : "home-scan-hint"}
          onClick={() => void scan()}
        >
          Сканировать QR
        </Button>
        {!scannerAvailable && <p id="home-scan-hint" className="home-hero__hint">Сканер работает в приложении MAX</p>}
      </section>

      {isEmpty && (
        <div className="home-empty">
          <EmptyState icon={<QrCode size={28} />} title="Сканируйте QR на столе или кассе">
            Меню откроется сразу, а заведение появится здесь.
          </EmptyState>
        </div>
      )}

      {home.admin_venues.length > 0 && (
        <Section id="home-admin" icon={<Store size={20} />} title="Мои заведения">
          <ul className="home-venues">
            {home.admin_venues.map((venue) => <AdminVenueCard key={venue.id} venue={venue} />)}
          </ul>
        </Section>
      )}

      {home.recent.length > 0 && (
        <Section id="home-recent" icon={<Clock size={20} />} title="Недавние">
          <VenueRows venues={home.recent} icon={<Store size={20} />} />
        </Section>
      )}

      {home.favorites.length > 0 && (
        <Section id="home-favorites" icon={<Star size={20} />} title="Избранные">
          <VenueRows
            venues={home.favorites}
            icon={<Star size={20} />}
            end={(venue) => venue.notifications_enabled ? <Bell size={16} aria-label="Уведомления включены" /> : null}
          />
        </Section>
      )}

      <ul className="home-list">
        <li>
          <Link className="home-row" to="/notifications" onClick={() => haptics.selection()}>
            <span className="home-row__icon" aria-hidden="true"><Bell size={20} /></span>
            <span className="home-row__text">
              <span className="home-row__name">Уведомления</span>
            </span>
            <span className="home-row__end"><ChevronRight size={18} aria-hidden="true" /></span>
          </Link>
        </li>
      </ul>

      <div className="home-connect">
        <Button variant="secondary" fullWidth icon={<Store size={20} />} onClick={() => { haptics.selection(); navigate("/connect"); }}>
          Подключить своё заведение
        </Button>
        <Button variant="ghost" fullWidth icon={<Sparkles size={20} />} onClick={() => { haptics.selection(); navigate("/intro", { state: { from: "home" } }); }}>
          Что умеет Синица
        </Button>
      </div>
    </main>
  );
}

/**
 * Home of the mini app (`/` inside MAX without a start parameter, and `/home`)
 * «Главная». Data comes from `/me/home`, scoped to the session user by the server.
 */
function HomeScreen() {
  const home = useQuery({ queryKey: HOME_QUERY_KEY, queryFn: fetchHome, retry: 1 });
  if (home.isPending) return <HomeSkeleton />;
  if (home.isError) {
    return (
      <main className="app-screen">
        <header className="app-screen__bar"><BrandLockup width={160} /></header>
        <div className="home-empty">
          <EmptyState
            tone="danger"
            icon={<RotateCcw size={28} />}
            title="Главная не загрузилась"
            action={<Button icon={<RotateCcw size={20} />} loading={home.isFetching} onClick={() => void home.refetch()}>Попробовать снова</Button>}
          >
            Проверьте подключение и попробуйте снова.
          </EmptyState>
        </div>
      </main>
    );
  }
  return <HomeContent home={home.data} />;
}

export default function HomeSurface() {
  return (
    <AccountShell pendingLabel="Открываем приложение" frame="bare">
      <HomeScreen />
    </AccountShell>
  );
}
