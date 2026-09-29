import { Clock3, RotateCcw, SearchX, WifiOff } from "lucide-react";

import { Button, EmptyState, Skeleton } from "../../design";
import { isNotFound, isNotPublished } from "./api";
import "./guest.css";

/**
 * Loading and failure states of the guest menu:
 * a skeleton with the shape of the menu, a clear error with «Попробовать снова» that refetches
 * without restarting the app, «Меню ещё не опубликовано» and an unknown link.
 */
export function GuestStateScreen({ kind, error, retrying = false, onRetry }: {
  kind: "loading" | "error";
  error?: unknown;
  retrying?: boolean;
  onRetry?: () => void;
}) {
  if (kind === "loading") {
    return (
      <div className="g-root g-state" aria-busy="true">
        <p className="s-visually-hidden" role="status">Загружаем меню</p>
        <div className="g-cover">
          <Skeleton width="60%" height={28} radius="control" />
          <Skeleton width="45%" height={16} />
        </div>
        <div className="g-search"><Skeleton height={48} radius="control" /></div>
        <div className="g-skeleton-rail">
          {[88, 72, 96, 64].map((width) => <Skeleton key={width} width={width} height={40} radius="pill" />)}
        </div>
        <div className="g-main">
          <Skeleton width={120} height={24} />
          <div className="g-grid g-skeleton-grid">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="g-skeleton-card">
                <Skeleton height={120} radius="card" />
                <Skeleton width="70%" height={16} />
                <Skeleton width="40%" height={16} />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (isNotPublished(error)) {
    return (
      <main className="g-root g-state g-state--center">
        <EmptyState icon={<Clock3 size={28} />} title="Меню ещё не опубликовано">
          Заведение готовит меню. Загляните чуть позже.
        </EmptyState>
      </main>
    );
  }
  if (isNotFound(error)) {
    return (
      <main className="g-root g-state g-state--center">
        <EmptyState icon={<SearchX size={28} />} title="Меню не найдено">
          Проверьте ссылку или QR-код заведения.
        </EmptyState>
      </main>
    );
  }
  return (
    <main className="g-root g-state g-state--center">
      <EmptyState
        tone="danger"
        icon={<WifiOff size={28} />}
        title="Не удалось загрузить меню"
        action={<Button icon={<RotateCcw size={20} />} loading={retrying} onClick={onRetry}>Попробовать снова</Button>}
      >
        Проверьте интернет и попробуйте снова.
      </EmptyState>
    </main>
  );
}
