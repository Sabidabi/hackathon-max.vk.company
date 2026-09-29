import { useCallback, useLayoutEffect, useRef, type ComponentProps, type ReactNode } from "react";

import { Sheet } from "../../design";
import { easeIn, easeOut, easeSpring, fadeIn, motionMs, prefersReducedMotion, type Rect } from "./motion";

/** Where a sheet opens from: the card photo it grows out of (shared element). */
export interface SheetOrigin {
  /** Element the photo starts from; re-measured on close for the reverse morph. */
  element: HTMLElement | null;
  image: string | null;
}

type SheetProps = ComponentProps<typeof Sheet>;

const DRAG_CLOSE_DISTANCE = 110;
const DRAG_CLOSE_VELOCITY = 0.6; // px per ms

function ghostImage(image: string, rect: Rect, radius: string, source?: HTMLElement | null): HTMLImageElement {
  // Cloning the on-screen <img> reuses the decoded image, so the ghost paints in the first frame.
  const loaded = source?.querySelector("img") ?? null;
  const ghost = loaded ? (loaded.cloneNode(false) as HTMLImageElement) : document.createElement("img");
  ghost.removeAttribute("loading");
  if (!loaded) ghost.src = image;
  ghost.alt = "";
  ghost.className = "g-morph";
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    borderRadius: radius,
  });
  document.body.append(ghost);
  return ghost;
}

function morph(ghost: HTMLElement, from: Rect, to: Rect, duration: number, easing: string): Animation {
  const dx = to.left - from.left;
  const dy = to.top - from.top;
  const sx = from.width ? to.width / from.width : 1;
  const sy = from.height ? to.height / from.height : 1;
  ghost.style.transformOrigin = "0 0";
  return ghost.animate(
    [{ transform: "translate(0, 0) scale(1, 1)" }, { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }],
    { duration, easing, fill: "forwards" },
  );
}

function visibleRect(element: HTMLElement | null): Rect | null {
  if (!element?.isConnected) return null;
  const rect = element.getBoundingClientRect();
  if (!rect.width || rect.bottom < 0 || rect.top > window.innerHeight) return null;
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/**
 * The design-system Sheet with the guest-menu motion (P1-DOC-18): springs up, a card photo
 * morphs into the sheet photo, drag down on the header closes it with resistance, and every
 * close (✕, backdrop, Escape, MAX «Назад») animates out from wherever the sheet is — an
 * opening sheet can be closed at once. Reduced motion: a short fade, no movement.
 */
export function MotionSheet({ open, onClose, origin, children, ...rest }: Omit<SheetProps, "children" | "origin"> & {
  origin?: SheetOrigin | null;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  const originRef = useRef(origin);
  originRef.current = origin;

  const panelOf = () => contentRef.current?.closest<HTMLElement>(".s-sheet__panel") ?? null;

  const requestClose = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const panel = panelOf();
    if (!panel || typeof panel.animate !== "function") {
      latestClose.current();
      return;
    }
    const backdrop = panel.previousElementSibling as HTMLElement | null;
    const reduced = prefersReducedMotion();
    // Start from where the sheet is right now (mid-opening or mid-drag).
    const current = getComputedStyle(panel).transform;
    panel.getAnimations().forEach((animation) => animation.cancel());
    const duration = reduced ? 100 : Math.round(motionMs("--motion-base") * 0.85);
    const exit = reduced
      ? panel.animate([{ opacity: 1 }, { opacity: 0 }], { duration, fill: "forwards" })
      : panel.animate(
        [{ transform: current === "none" ? "translateY(0)" : current }, { transform: "translateY(105%)" }],
        { duration, easing: easeIn(), fill: "forwards" },
      );
    backdrop?.animate([{ opacity: 1 }, { opacity: 0 }], { duration, fill: "forwards" });
    // Reverse morph: the photo returns to its card if the card is on screen.
    const photo = contentRef.current?.querySelector<HTMLElement>(".g-item__photo");
    const image = originRef.current?.image;
    const back = visibleRect(originRef.current?.element ?? null);
    const from = photo ? visibleRect(photo) : null;
    if (!reduced && photo && image && back && from) {
      photo.style.opacity = "0";
      const ghost = ghostImage(image, from, "20px");
      const flight = morph(ghost, from, back, duration, easeOut());
      const drop = () => ghost.remove();
      flight.onfinish = drop;
      flight.oncancel = drop;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      latestClose.current();
    };
    exit.onfinish = finish;
    exit.oncancel = finish;
    window.setTimeout(finish, duration + 120);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    closing.current = false;
    const panel = panelOf();
    if (!panel || typeof panel.animate !== "function") return;
    panel.style.animation = "none";
    panel.getAnimations().forEach((animation) => animation.cancel());
    const cleanups: Array<() => void> = [];
    if (prefersReducedMotion()) {
      fadeIn(panel);
    } else {
      const duration = Math.round(motionMs("--motion-slow") * 1.15);
      // Measure the final photo place before the panel starts below the screen.
      const photo = contentRef.current?.querySelector<HTMLElement>(".g-item__photo");
      const end = photo?.getBoundingClientRect();
      panel.animate([{ transform: "translateY(100%)" }, { transform: "translateY(0)" }], { duration, easing: easeSpring() });
      // Shared element: the card photo grows into the sheet photo.
      const start = visibleRect(originRef.current?.element ?? null);
      const image = originRef.current?.image;
      if (photo && end && start && image) {
        photo.style.opacity = "0";
        const ghost = ghostImage(image, start, "20px 20px 0 0", originRef.current?.element);
        const flight = morph(ghost, start, { left: end.left, top: end.top, width: end.width, height: end.height }, duration, easeSpring());
        const reveal = () => {
          photo.style.opacity = "";
          ghost.remove();
        };
        flight.onfinish = reveal;
        flight.oncancel = reveal;
        cleanups.push(reveal);
      }
    }

    // Drag down to close (header and grip), with resistance upwards.
    const handle = panel.querySelector<HTMLElement>(".s-sheet__header");
    const grip = panel.querySelector<HTMLElement>(".s-sheet__grip");
    let startY = 0;
    let lastY = 0;
    let lastTime = 0;
    let velocity = 0;
    let dragging = false;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
      dragging = true;
      startY = lastY = event.clientY;
      lastTime = event.timeStamp;
      velocity = 0;
      panel.getAnimations().forEach((animation) => animation.cancel());
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      if (!dragging) return;
      const delta = event.clientY - startY;
      const offset = delta > 0 ? delta : delta * 0.2;
      if (event.timeStamp > lastTime) velocity = (event.clientY - lastY) / (event.timeStamp - lastTime);
      lastY = event.clientY;
      lastTime = event.timeStamp;
      panel.style.transform = `translateY(${offset}px)`;
    };
    const onUp = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      const delta = event.clientY - startY;
      if (delta > DRAG_CLOSE_DISTANCE || (delta > 24 && velocity > DRAG_CLOSE_VELOCITY)) {
        requestClose();
        panel.style.transform = "";
        return;
      }
      const from = panel.style.transform || "translateY(0)";
      panel.style.transform = "";
      if (!prefersReducedMotion()) {
        panel.animate([{ transform: from }, { transform: "translateY(0)" }], { duration: motionMs("--motion-base"), easing: easeSpring() });
      }
    };
    for (const target of [handle, grip]) {
      if (!target) continue;
      target.style.touchAction = "none";
      target.addEventListener("pointerdown", onDown);
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onUp);
      cleanups.push(() => {
        target.removeEventListener("pointerdown", onDown);
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onUp);
      });
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [open, requestClose]);

  return (
    <Sheet open={open} onClose={requestClose} {...rest}>
      <div ref={contentRef} className="g-sheet-content">{children}</div>
    </Sheet>
  );
}
