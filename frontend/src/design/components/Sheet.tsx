import { X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useBackButton } from "../../max/useBackButton";
import { morphFrom, morphTo, play, prefersReducedMotion, settled } from "../motion";
import { IconButton } from "./IconButton";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Drag distance (share of the panel height) or speed (px/ms) that closes the sheet. */
const CLOSE_SHARE = 0.25;
const CLOSE_VELOCITY = 0.6;
const DRAG_THRESHOLD = 6;

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Sticky footer with the main action. */
  footer?: ReactNode;
  /** Label of the close button; defaults to «Закрыть». */
  closeLabel?: string;
  /**
   * Shared element: the element the sheet grows out of (a menu row) and shrinks
   * back into on close. Without it the sheet rises from the bottom edge.
   */
  origin?: Element | null;
  /** Content between the header and the scrolling body (tabs). */
  toolbar?: ReactNode;
  /** Wider dialog on desktop (editor cards). */
  wide?: boolean;
}

function isPhone(): boolean {
  try {
    return !window.matchMedia("(min-width: 768px)").matches;
  } catch {
    return true;
  }
}

function currentTransform(element: HTMLElement): string {
  const value = getComputedStyle(element).transform;
  return value && value !== "none" ? value : "translateY(0px)";
}

/**
 * Bottom sheet on phones, centred dialog from 768 px. Modal: traps Tab focus, closes on
 * Escape, on the backdrop and on the native MAX «Назад», returns focus to the
 * element that opened it and locks page scroll while open.
 *
 * Motion: rises on a spring (or grows out of `origin`), leaves faster than it
 * came; on phones it follows a downward drag of the grip/header with resistance and closes
 * past a quarter of its height or on a flick. Every animation starts from the current
 * position, so reopening or «Назад» mid-way interrupts it at once. Reduced motion: no moves.
 */
export function Sheet({ open, onClose, title, children, footer, closeLabel = "Закрыть", origin = null, toolbar, wide }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  const originRef = useRef<Element | null>(origin);
  if (open) originRef.current = origin;
  const openRef = useRef(open);
  openRef.current = open;
  // Stays mounted while the closing animation plays.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  useBackButton(open ? () => latestClose.current() : null);

  // Enter: spring from the bottom edge, or the shared element from `origin`.
  useLayoutEffect(() => {
    if (!open || !mounted) return;
    const panel = panelRef.current;
    if (!panel) return;
    panel.style.transform = "";
    play(backdropRef.current, [{ opacity: 0 }, { opacity: 1 }], { duration: "base" });
    const source = originRef.current;
    if (source?.isConnected && morphFrom(source, panel)) return;
    play(panel, isPhone()
      ? [{ transform: "translateY(100%)" }, { transform: "translateY(0)" }]
      : [{ opacity: 0, transform: "translateY(16px) scale(0.98)" }, { opacity: 1, transform: "none" }],
    { duration: "base", easing: "spring" });
  }, [open, mounted]);

  // Exit: from wherever the panel is now (mid-open, mid-drag) — faster than the entrance.
  useLayoutEffect(() => {
    if (open || !mounted) return;
    const panel = panelRef.current;
    if (!panel || prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    // Closed by a drag: keep going down; otherwise shrink back into the origin row.
    const dragged = Boolean(panel.style.transform);
    const from = currentTransform(panel);
    panel.style.transform = "";
    const source = originRef.current;
    const exit = (source?.isConnected && !dragged ? morphTo(source, panel) : null)
      ?? play(panel, isPhone()
        ? [{ transform: from }, { transform: "translateY(100%)" }]
        : [{ opacity: 1, transform: from }, { opacity: 0, transform: "translateY(16px) scale(0.98)" }],
      { duration: "fast", easing: "in", fill: "forwards" });
    play(backdropRef.current, [{ opacity: 1 }, { opacity: 0 }], { duration: "fast", easing: "in", fill: "forwards" });
    void settled(exit).then(() => {
      if (!openRef.current) setMounted(false);
    });
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>("[data-autofocus]") ?? panel;
    first?.focus({ preventScroll: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        latestClose.current();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.offsetParent !== null);
      if (!focusable.length) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const firstItem = focusable[0];
      const lastItem = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === firstItem || active === panel)) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault();
        firstItem.focus();
      } else if (!panel.contains(active)) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  // Drag to close (phones): the grip and the header follow the finger.
  const drag = useRef<{ pointerId: number; startY: number; lastY: number; lastTime: number; velocity: number; active: boolean } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isPhone() || event.button !== 0 || (event.target as Element).closest("button, a, input, select, textarea")) return;
    drag.current = { pointerId: event.pointerId, startY: event.clientY, lastY: event.clientY, lastTime: event.timeStamp, velocity: 0, active: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    const panel = panelRef.current;
    if (!state || !panel || state.pointerId !== event.pointerId) return;
    const dy = event.clientY - state.startY;
    if (!state.active) {
      if (Math.abs(dy) < DRAG_THRESHOLD) return;
      state.active = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      panel.getAnimations().forEach((animation) => animation.cancel());
    }
    const elapsed = Math.max(1, event.timeStamp - state.lastTime);
    state.velocity = (event.clientY - state.lastY) / elapsed;
    state.lastY = event.clientY;
    state.lastTime = event.timeStamp;
    // Downwards: follows with light resistance; upwards: a short rubber band.
    const offset = dy > 0 ? dy * 0.9 : -Math.sqrt(-dy) * 2;
    panel.style.transform = `translateY(${offset}px)`;
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    const panel = panelRef.current;
    drag.current = null;
    if (!state?.active || !panel) return;
    const dy = event.clientY - state.startY;
    if (dy > panel.offsetHeight * CLOSE_SHARE || state.velocity > CLOSE_VELOCITY) {
      latestClose.current();
      return;
    }
    const from = currentTransform(panel);
    panel.style.transform = "";
    play(panel, [{ transform: from }, { transform: "translateY(0)" }], { duration: "base", easing: "spring" });
  };
  const dragHandlers = { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd };

  if (!mounted || typeof document === "undefined") return null;
  return createPortal(
    <div className={["s-sheet", !open && "s-sheet--closing"].filter(Boolean).join(" ")}>
      <div ref={backdropRef} className="s-sheet__backdrop" aria-hidden="true" onClick={() => latestClose.current()} />
      <div
        ref={panelRef}
        className={["s-sheet__panel", wide && "s-sheet__panel--wide"].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="s-sheet__handle" {...dragHandlers}>
          <span className="s-sheet__grip" aria-hidden="true" />
          <header className="s-sheet__header">
            <h2 id={titleId} className="s-sheet__title">{title}</h2>
            <IconButton aria-label={closeLabel} icon={<X size={22} />} onClick={() => latestClose.current()} />
          </header>
        </div>
        {toolbar && <div className="s-sheet__toolbar">{toolbar}</div>}
        <div className="s-sheet__body">{children}</div>
        {footer && <footer className="s-sheet__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
