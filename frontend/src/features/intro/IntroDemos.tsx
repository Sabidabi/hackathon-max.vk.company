import { Coffee, Plus, QrCode, ScanLine, ShoppingBag, ToggleRight } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { BrandLockup, Button, RollingNumber, Switch, Toast } from "../../design";
import { flyToTarget, pop, prefersReducedMotion } from "../../design/motion";
import { haptics } from "../../max";

/*
 * Live mini-demos of the intro (P1-TASK-62): real design-system components on demo data,
 * not pictures. Each demo plays its key moment once when it appears (P1-DOC-18: motion =
 * meaning, no endless loops) and hands over to the user on the first touch. With reduced
 * motion nothing plays by itself; the demo stays interactive and changes instantly.
 */

const rub = (value: number) => `${value} ₽`;

/** Runs `steps` once after mount unless the user touches the demo first or motion is reduced. */
function useAutoplay(steps: Array<[number, () => void]>): () => void {
  const timers = useRef<number[]>([]);
  const stop = () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current = [];
  };
  useEffect(() => {
    if (prefersReducedMotion()) return;
    timers.current = steps.map(([delay, run]) => window.setTimeout(run, delay));
    return stop;
  }, []); // Steps are fixed for the life of the demo.
  return stop;
}

// --- Brand ---------------------------------------------------------------------------------

export function BrandDemo() {
  const values: Array<[ReactNode, string]> = [
    [<ScanLine key="qr" size={18} />, "Меню по QR"],
    [<ShoppingBag key="choice" size={18} />, "Выбор без очереди"],
    [<ToggleRight key="stop" size={18} />, "Стоп-лист в один тап"],
  ];
  return (
    <div className="intro-brand">
      <span className="intro-brand__lockup" data-enter><BrandLockup width={240} tone="white" /></span>
      <ul className="intro-brand__values" aria-label="Что умеет Синица">
        {values.map(([icon, label]) => (
          <li key={label} data-enter><span aria-hidden="true">{icon}</span>{label}</li>
        ))}
      </ul>
    </div>
  );
}

// --- Guest: latte → «Мой выбор» -------------------------------------------------------------

const SIZES = [
  { volume: 250, price: 190 },
  { volume: 350, price: 230 },
  { volume: 450, price: 260 },
];

export function GuestDemo() {
  const [size, setSize] = useState(0);
  const [count, setCount] = useState(0);
  const [total, setTotal] = useState(0);
  const [pressed, setPressed] = useState(false);
  const photo = useRef<HTMLSpanElement>(null);
  const badge = useRef<HTMLSpanElement>(null);
  const price = SIZES[size].price;
  const sizeRef = useRef(size);
  sizeRef.current = size;

  function add(fromUser: boolean) {
    if (fromUser) haptics.impact("light");
    void flyToTarget(photo.current, badge.current).then(() => {
      if (fromUser) haptics.notify("success");
    });
    setCount((value) => value + 1);
    setTotal((value) => value + SIZES[sizeRef.current].price);
  }

  const stop = useAutoplay([
    [900, () => setSize(1)],
    [1_700, () => setPressed(true)],
    [1_860, () => { setPressed(false); add(false); }],
  ]);

  return (
    <div className="intro-guest" onPointerDown={stop} onKeyDown={stop}>
      <article className="intro-card" data-enter aria-label="Латте, демо">
        <div className="intro-card__head">
          <span ref={photo} className="intro-card__photo" aria-hidden="true"><Coffee size={26} strokeWidth={2.25} /></span>
          <span className="intro-card__title">
            <strong>Латте</strong>
            <span>Эспрессо, молоко</span>
          </span>
          <RollingNumber className="intro-card__price" value={price} format={rub} />
        </div>
        <div className="intro-sizes" role="radiogroup" aria-label="Объём" style={{ "--size-index": size } as CSSProperties}>
          <span className="intro-sizes__thumb" aria-hidden="true" />
          {SIZES.map((option, index) => (
            <button
              key={option.volume}
              type="button"
              role="radio"
              aria-checked={size === index}
              className="intro-sizes__option"
              onClick={() => { haptics.selection(); setSize(index); }}
            >
              {option.volume} мл
            </button>
          ))}
        </div>
        <Button fullWidth icon={<Plus size={20} />} className={pressed ? "intro-press" : undefined} onClick={() => add(true)}>
          В мой выбор · <RollingNumber value={price} format={rub} />
        </Button>
      </article>
      <div className={`intro-choice${count ? " intro-choice--shown" : ""}`} data-enter-skip aria-hidden={!count || undefined}>
        <span className="intro-choice__label">
          <span ref={badge} className="intro-choice__count"><RollingNumber value={count} /></span>
          Мой выбор
        </span>
        <span className="intro-choice__total"><RollingNumber value={total} format={rub} /></span>
      </div>
    </div>
  );
}

// --- Owner: stop list in one tap ------------------------------------------------------------

const ITEMS = [
  { name: "Латте", price: 230 },
  { name: "Капучино", price: 210 },
  { name: "Круассан", price: 180 },
];

export function OwnerDemo() {
  const [hidden, setHidden] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const rows = useRef<Record<string, HTMLLIElement | null>>({});

  function showToast(name: string | null) {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast(name);
    if (name) toastTimer.current = window.setTimeout(() => setToast(null), 5_000);
  }
  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);

  function toggle(name: string, available: boolean, fromUser: boolean) {
    if (fromUser) haptics.selection();
    setHidden(available ? null : name);
    showToast(available ? null : name);
    if (available) pop(rows.current[name]);
  }

  const stop = useAutoplay([[1_000, () => toggle("Круассан", false, false)]]);

  return (
    <div className="intro-owner" onPointerDown={stop} onKeyDown={stop}>
      <section className="intro-card intro-card--owner" data-enter aria-label="Меню заведения, демо">
        <header className="intro-owner__head">
          <strong>Меню</strong>
          <span className="intro-owner__qr"><QrCode size={16} aria-hidden="true" />QR готов</span>
        </header>
        <ul className="intro-owner__rows">
          {ITEMS.map((item) => {
            const off = hidden === item.name;
            return (
              <li key={item.name} ref={(node) => { rows.current[item.name] = node; }} className={`intro-row${off ? " intro-row--off" : ""}`}>
                <span className="intro-row__text">
                  <span className="intro-row__name">{item.name}</span>
                  <span className="intro-row__meta">{off ? "Скрыто для гостей" : rub(item.price)}</span>
                </span>
                <Switch compact checked={!off} label={`${item.name} в наличии`} onChange={(checked) => toggle(item.name, checked, true)} />
              </li>
            );
          })}
        </ul>
      </section>
      <div className="intro-owner__toast">
        {toast && (
          <Toast
            action={(
              <Button variant="ghost" className="s-toast__action" onClick={() => { stop(); toggle(toast, true, true); }}>
                Отменить
              </Button>
            )}
          >
            {toast} скрыт
          </Toast>
        )}
      </div>
    </div>
  );
}
