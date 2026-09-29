// Imperative toasts for any code, inside React or not (MAX fallbacks: «Ссылка скопирована»;
// quick actions with «Отменить», P1-DOC-17). Same look as the <Toast> component
// (components/components.css). A stack of at most two: the newest is at the bottom and has
// id `app-toast`; a third one pushes the oldest out. Motion (P1-DOC-18): enters on a spring
// from below, leaves down with a fade, the older toast slides up (FLIP).

import { flip, measure, play, settled } from "./motion";

export type ToastTone = "neutral" | "success" | "danger";

export interface ToastOptions {
  /** How long the toast stays, ms. Defaults: 2.5 s, 6 s with an action (≥ 5 s to undo). */
  duration?: number;
  tone?: ToastTone;
  /** One action, e.g. «Отменить». The toast closes after it is pressed. */
  action?: { label: string; onClick: () => void };
}

const REGION_ID = "app-toast-region";
const TOAST_ID = "app-toast";
const MAX_TOASTS = 2;
const MIN_ACTION_MS = 5_000;

interface Entry {
  element: HTMLElement;
  timer: number | undefined;
  remaining: number;
  startedAt: number;
  closing: boolean;
}

const entries: Entry[] = [];

/** Elements toasts must never cover: the sticky publish bar and an open sheet's footer. */
const AVOID_SELECTOR = "[data-toast-avoid], .s-sheet__footer";
const GAP_PX = 8;
let clearanceFrame = 0;

/** Distance from the viewport bottom to the highest visible element toasts must stay above. */
export function toastClearance(): number {
  const height = window.innerHeight;
  let clear = 0;
  document.querySelectorAll<HTMLElement>(AVOID_SELECTOR).forEach((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0 || rect.top >= height || rect.bottom <= 0) return;
    clear = Math.max(clear, height - rect.top);
  });
  return clear;
}

/** Lifts the stack above the avoided elements while toasts are shown (they can move). */
function trackClearance(): void {
  if (clearanceFrame || typeof window.requestAnimationFrame !== "function") return;
  const tick = () => {
    const container = document.getElementById(REGION_ID);
    if (!container || !entries.length) {
      clearanceFrame = 0;
      if (container) container.style.bottom = "";
      return;
    }
    const clear = toastClearance();
    container.style.bottom = clear > 0 ? `${Math.round(clear + GAP_PX)}px` : "";
    clearanceFrame = window.requestAnimationFrame(tick);
  };
  tick();
}

function region(): HTMLElement {
  let element = document.getElementById(REGION_ID);
  if (!element) {
    element = document.createElement("div");
    element.id = REGION_ID;
    element.className = "s-toast-region";
    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    document.body.append(element);
  }
  return element;
}

function dismiss(entry: Entry): void {
  if (entry.closing) return;
  entry.closing = true;
  window.clearTimeout(entry.timer);
  const index = entries.indexOf(entry);
  if (index >= 0) entries.splice(index, 1);
  if (entry.element.id === TOAST_ID) {
    entry.element.id = "";
    const newest = entries[entries.length - 1];
    if (newest) newest.element.id = TOAST_ID;
  }
  const leaving = play(entry.element, [
    { opacity: 1, transform: "translateY(0)" },
    { opacity: 0, transform: "translateY(12px)" },
  ], { duration: "fast", easing: "in", fill: "forwards" });
  void settled(leaving).then(() => {
    const parent = entry.element.parentElement;
    const others = parent ? Array.from(parent.children).filter((child) => child !== entry.element) : [];
    const before = measure(others);
    entry.element.remove();
    flip(before, others, { duration: "fast", easing: "out" });
  });
}

function schedule(entry: Entry): void {
  window.clearTimeout(entry.timer);
  entry.startedAt = Date.now();
  entry.timer = window.setTimeout(() => dismiss(entry), entry.remaining);
}

/**
 * Shows a toast and returns a function that closes it. Say what happened: «Изменения
 * сохранены», «Круассан скрыт на Тверской». Never throws: a toast is a courtesy.
 */
export function showToast(message: string, options: number | ToastOptions = {}): () => void {
  if (typeof document === "undefined") return () => undefined;
  const settings: ToastOptions = typeof options === "number" ? { duration: options } : options;
  try {
    const container = region();
    const element = document.createElement("div");
    element.className = `s-toast s-toast--${settings.tone ?? "neutral"} s-toast--floating`;
    const entry: Entry = {
      element,
      timer: undefined,
      remaining: Math.max(settings.duration ?? (settings.action ? 6_000 : 2_500), settings.action ? MIN_ACTION_MS : 0),
      startedAt: Date.now(),
      closing: false,
    };
    if (settings.action) {
      const { label, onClick } = settings.action;
      const text = document.createElement("span");
      text.className = "s-toast__text";
      text.textContent = message;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "s-button s-button--ghost s-toast__action";
      button.textContent = label;
      button.addEventListener("click", () => {
        dismiss(entry);
        onClick();
      });
      element.append(text, button);
      // Reading or reaching for «Отменить» pauses the countdown.
      const pause = () => {
        window.clearTimeout(entry.timer);
        entry.remaining = Math.max(1_500, entry.remaining - (Date.now() - entry.startedAt));
      };
      const resume = () => { if (!entry.closing) schedule(entry); };
      element.addEventListener("pointerenter", pause);
      element.addEventListener("pointerleave", resume);
      element.addEventListener("focusin", pause);
      element.addEventListener("focusout", resume);
    } else {
      element.textContent = message;
    }
    const previous = entries[entries.length - 1];
    if (previous) previous.element.id = "";
    element.id = TOAST_ID;
    const older = entries.map((item) => item.element);
    const before = typeof element.getBoundingClientRect === "function" ? measure(older) : new Map();
    container.append(element);
    entries.push(entry);
    if (before.size) flip(before, older, { duration: "base", easing: "spring" });
    while (entries.length > MAX_TOASTS) dismiss(entries[0]);
    schedule(entry);
    trackClearance();
    return () => dismiss(entry);
  } catch {
    return () => undefined;
  }
}
