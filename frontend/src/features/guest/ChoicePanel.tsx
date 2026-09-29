import { Minus, Plus, RotateCcw, ShoppingBag, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button, IconButton } from "../../design";
import { boostBrightness, haptics, restoreBrightness, useBackButton } from "../../max";
import { formatMoney } from "./api";
import { CHOICE_QTY_MAX, CHOICE_QTY_MIN, lineDetails, pluralPositions } from "./choice";
import { easeOut, fadeIn, motionMs, prefersReducedMotion } from "./motion";
import { MotionSheet } from "./MotionSheet";
import { RollingText } from "./RollingText";
import type { ChoiceTotals, ChoiceView } from "./useChoice";

function totalLabel(totals: ChoiceTotals): string {
  return totals.totalMinor === null ? "Считаем…" : formatMoney(totals.totalMinor);
}

/** Sticky bar «Мой выбор · 2 позиции · 420 ₽» — appears after the first addition. */
export function ChoiceBar({ totals, onOpen }: { totals: ChoiceTotals; onOpen: () => void }) {
  if (!totals.count) return null;
  return (
    <div className="g-choice-bar">
      <button type="button" className="g-choice-bar__button" onClick={onOpen} aria-label={`Мой выбор: ${pluralPositions(totals.count)}, ${totalLabel(totals)}`}>
        <ShoppingBag size={20} aria-hidden="true" />
        <span className="g-choice-bar__text">
          <strong>Мой выбор</strong>
          <span className="g-choice-bar__count">
            <span key={totals.count} className="g-choice-bar__qty">{pluralPositions(totals.count)}</span> · <RollingText value={totalLabel(totals)} />
          </span>
        </span>
        <span className="g-choice-bar__action">Показать</span>
      </button>
    </div>
  );
}

/** «Мой выбор»: lines with quantity 1–20, removal, the server total and «Показать на кассе». */
export function ChoiceSheet({
  open,
  views,
  totals,
  onClose,
  onQty,
  onRemove,
  onRetry,
  onShow,
}: {
  open: boolean;
  views: ChoiceView[];
  totals: ChoiceTotals;
  onClose: () => void;
  onQty: (lineId: string, qty: number) => void;
  onRemove: (lineId: string) => void;
  onRetry: () => void;
  /** `from` — centre of «Показать на кассе»: the summary opens out of it. */
  onShow: (from: { x: number; y: number }) => void;
}) {
  // A removed line first fades and slides out (transform/opacity), then leaves the list.
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const leave = useCallback((lineId: string) => {
    setLeaving((current) => (current.has(lineId) ? current : new Set(current).add(lineId)));
    const finish = () => {
      setLeaving((current) => {
        const next = new Set(current);
        next.delete(lineId);
        return next;
      });
      onRemove(lineId);
    };
    if (prefersReducedMotion()) finish();
    else window.setTimeout(finish, motionMs("--motion-base"));
  }, [onRemove]);
  return (
    <MotionSheet
      open={open}
      onClose={onClose}
      title="Мой выбор"
      footer={views.length ? (
        <div className="g-choice-footer">
          <div className="g-choice-footer__total">
            <small>Итого</small>
            <RollingText testId="choice-total" value={totalLabel(totals)} />
          </div>
          <Button
            disabled={!totals.availableCount || totals.totalMinor === null}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onShow({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
            }}
          >
            Показать на кассе
          </Button>
        </div>
      ) : undefined}
    >
      {!views.length ? (
        <p className="g-muted">Добавьте позиции из меню — здесь появится итог.</p>
      ) : (
        <>
          <ul className="g-choice-list">
            {views.map(({ line, state }) => {
              const off = state.kind === "unavailable";
              return (
                <li key={line.lineId} className={`g-choice-line${off ? " g-choice-line--off" : ""}${leaving.has(line.lineId) ? " g-choice-line--leaving" : ""}`}>
                  <div className="g-choice-line__main">
                    <strong>{line.name}</strong>
                    {lineDetails(line) && <span className="g-muted">{lineDetails(line)}</span>}
                    {state.kind === "unavailable" && <span className="g-badge g-badge--muted">{state.reason}</span>}
                    {state.kind === "ok" && state.priceUpdated && <span className="g-badge g-badge--warning">Цена обновлена</span>}
                    {state.kind === "error" && <span className="g-badge g-badge--danger">{state.message}</span>}
                  </div>
                  <div className="g-choice-line__side">
                    <span className="g-choice-line__price">
                      {state.kind === "ok" ? formatMoney(state.totalPriceMinor) : state.kind === "pending" ? "…" : "—"}
                    </span>
                    <span className="g-stepper">
                      <button
                        type="button"
                        aria-label={line.qty <= CHOICE_QTY_MIN ? `Убрать: ${line.name}` : `Меньше: ${line.name}`}
                        disabled={leaving.has(line.lineId)}
                        onClick={() => {
                          haptics.selection();
                          if (line.qty <= CHOICE_QTY_MIN) leave(line.lineId);
                          else onQty(line.lineId, line.qty - 1);
                        }}
                      >
                        {line.qty <= CHOICE_QTY_MIN ? <Trash2 size={16} aria-hidden="true" /> : <Minus size={16} aria-hidden="true" />}
                      </button>
                      <output aria-label={`Количество: ${line.name}`}>{line.qty}</output>
                      <button
                        type="button"
                        aria-label={`Больше: ${line.name}`}
                        disabled={line.qty >= CHOICE_QTY_MAX || off || leaving.has(line.lineId)}
                        onClick={() => {
                          haptics.selection();
                          onQty(line.lineId, line.qty + 1);
                        }}
                      >
                        <Plus size={16} aria-hidden="true" />
                      </button>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          {totals.hasErrors && (
            <Button variant="secondary" icon={<RotateCcw size={18} />} onClick={onRetry}>Пересчитать</Button>
          )}
          <p className="g-muted g-choice-note">Цены считает сервер по опубликованному меню. Оплата — на кассе.</p>
        </>
      )}
    </MotionSheet>
  );
}

/**
 * «Показать на кассе»: full-screen summary in large type for the cashier, with the screen
 * brightness raised in MAX and the native «Назад» closing it.
 */
export function CashierView({ venueName, views, totals, onClose, from }: {
  venueName: string;
  views: ChoiceView[];
  totals: ChoiceTotals;
  onClose: () => void;
  from?: { x: number; y: number } | null;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  useBackButton(onClose);

  // Opens out of the «Показать на кассе» button (clip-path circle), a fade with reduced motion.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof root.animate !== "function") return;
    if (prefersReducedMotion() || !from) {
      fadeIn(root);
      return;
    }
    const radius = Math.hypot(Math.max(from.x, window.innerWidth - from.x), Math.max(from.y, window.innerHeight - from.y));
    root.animate(
      [{ clipPath: `circle(24px at ${from.x}px ${from.y}px)`, opacity: 0.6 }, { clipPath: `circle(${radius}px at ${from.x}px ${from.y}px)`, opacity: 1 }],
      { duration: motionMs("--motion-slow"), easing: easeOut() },
    );
    // Opening geometry is read once, on mount.
  }, []);

  useEffect(() => {
    void boostBrightness();
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      void restoreBrightness();
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, [onClose]);

  const lines = views.filter((view) => view.state.kind === "ok");
  return createPortal(
    <div ref={rootRef} className="g-cashier" role="dialog" aria-modal="true" aria-labelledby="g-cashier-title">
      <header className="g-cashier__header">
        <div>
          <p className="g-cashier__venue">{venueName}</p>
          <h2 id="g-cashier-title" className="g-cashier__title">Мой выбор</h2>
        </div>
        <IconButton ref={closeRef} aria-label="Закрыть сводку" icon={<X size={24} />} onClick={onClose} />
      </header>
      <ol className="g-cashier__list">
        {lines.map(({ line, state }) => (
          <li key={line.lineId}>
            <span className="g-cashier__qty">{line.qty}×</span>
            <span className="g-cashier__name">
              <strong>{line.name}</strong>
              {lineDetails(line) && <span>{lineDetails(line)}</span>}
            </span>
            <span className="g-cashier__price">{state.kind === "ok" ? formatMoney(state.totalPriceMinor) : ""}</span>
          </li>
        ))}
      </ol>
      <footer className="g-cashier__total">
        <span>Итого</span>
        <strong data-testid="cashier-total">{totalLabel(totals)}</strong>
      </footer>
      <p className="g-cashier__note">Покажите экран на кассе. Оплата — у кассира.</p>
    </div>,
    document.body,
  );
}
