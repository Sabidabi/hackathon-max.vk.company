import { useLayoutEffect, useRef, type ReactNode } from "react";

import { RollingNumber } from "./RollingNumber";

export interface TabBarItem<K extends string> {
  key: K;
  label: string;
  icon: ReactNode;
  /** Small counter, e.g. unpublished changes. Omit when zero. */
  badge?: number;
}

interface TabBarProps<K extends string> {
  items: Array<TabBarItem<K>>;
  value: K;
  onChange: (key: K) => void;
  label: string;
  /** `fixed` pins the bar to the bottom of the viewport with safe-area padding. */
  fixed?: boolean;
  /** `vertical`: the left navigation column of the desktop cabinet (≥ 1024 px). */
  orientation?: "horizontal" | "vertical";
  className?: string;
}

/**
 * Cabinet navigation (Меню │ Аналитика │ Оформление │ Ещё): a bottom bar on phones and the
 * same items as a left column on desktop. The active indicator slides to the new tab
 * (P1-DOC-18 «Навигация кабинета») — only its transform changes; reduced motion: it jumps.
 */
export function TabBar<K extends string>({ items, value, onChange, label, fixed, orientation = "horizontal", className }: TabBarProps<K>) {
  const navRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const vertical = orientation === "vertical";

  useLayoutEffect(() => {
    const nav = navRef.current;
    const indicator = indicatorRef.current;
    if (!nav || !indicator) return;
    const place = () => {
      const active = nav.querySelector<HTMLElement>(".s-tabbar__item--active");
      if (!active) {
        indicator.removeAttribute("data-ready");
        return;
      }
      const navBox = nav.getBoundingClientRect();
      if (vertical) {
        const box = active.getBoundingClientRect();
        indicator.style.width = `${box.width}px`;
        indicator.style.height = `${box.height}px`;
        indicator.style.transform = `translate(${box.left - navBox.left}px, ${box.top - navBox.top}px)`;
      } else {
        const icon = active.querySelector<HTMLElement>(".s-tabbar__icon") ?? active;
        const box = icon.getBoundingClientRect();
        const width = 56;
        const height = 32;
        indicator.style.width = `${width}px`;
        indicator.style.height = `${height}px`;
        indicator.style.transform = `translate(${box.left + box.width / 2 - width / 2 - navBox.left}px, ${box.top + box.height / 2 - height / 2 - navBox.top}px)`;
      }
      // The first placement does not animate; later changes slide.
      if (!indicator.hasAttribute("data-ready")) requestAnimationFrame(() => indicator.setAttribute("data-ready", ""));
    };
    place();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      indicator.removeAttribute("data-ready");
      place();
    });
    observer.observe(nav);
    return () => observer.disconnect();
  }, [value, vertical, items.length]);

  return (
    <nav
      ref={navRef}
      className={["s-tabbar", fixed && "s-tabbar--fixed", vertical && "s-tabbar--vertical", className].filter(Boolean).join(" ")}
      aria-label={label}
      data-active-tab={value}
    >
      <span ref={indicatorRef} className="s-tabbar__indicator" aria-hidden="true" />
      {items.map((item) => {
        const active = item.key === value;
        return (
          <button
            key={item.key}
            type="button"
            aria-label={item.label}
            data-tab-key={item.key}
            className={["s-tabbar__item", active && "s-tabbar__item--active"].filter(Boolean).join(" ")}
            aria-current={active ? "page" : undefined}
            onClick={() => onChange(item.key)}
          >
            <span className="s-tabbar__icon" aria-hidden="true">
              {item.icon}
              {item.badge ? <span className="s-tabbar__badge"><RollingNumber value={Math.min(item.badge, 99)} format={(n) => (item.badge! > 99 ? "99+" : String(n))} /></span> : null}
            </span>
            <span className="s-tabbar__label">{item.label}</span>
            {item.badge ? <span className="s-visually-hidden">, изменений: {item.badge}</span> : null}
          </button>
        );
      })}
    </nav>
  );
}
