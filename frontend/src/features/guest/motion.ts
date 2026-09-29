// Motion of the guest menu (P1-DOC-18 «Премиальные анимации», раздел «Гость»).
// Only transform / opacity (and a point clip-path), Web Animations API, no dependencies.
// Durations and curves come from motion tokens with fallbacks: the shared tokens
// (`--motion-*`, `--ease-*`, `--stagger` in src/design/tokens.css) are added by the design
// system owner; until then the fallbacks below apply. `prefers-reduced-motion: reduce` →
// no movement, at most an opacity change ≤ 120 ms.

export type Rect = { left: number; top: number; width: number; height: number };

const FALLBACK = {
  "--motion-instant": 80,
  "--motion-fast": 140,
  "--motion-base": 240,
  "--motion-slow": 360,
  "--stagger": 30,
} as const;

type DurationToken = keyof typeof FALLBACK;

function readVar(name: string): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return "";
  }
}

/** A duration token in ms (`240ms` / `0.24s`), or its fallback. */
export function motionMs(token: DurationToken): number {
  const raw = readVar(token);
  const value = Number.parseFloat(raw);
  if (!raw || Number.isNaN(value)) return FALLBACK[token];
  return raw.endsWith("ms") ? value : raw.endsWith("s") ? value * 1000 : value;
}

export const EASE_OUT_FALLBACK = "cubic-bezier(0.2, 0, 0, 1)";
export const EASE_IN_FALLBACK = "cubic-bezier(0.4, 0, 1, 1)";

export function easeOut(): string {
  return readVar("--ease-out") || EASE_OUT_FALLBACK;
}

export function easeIn(): string {
  return readVar("--ease-in") || EASE_IN_FALLBACK;
}

let springCache: string | null = null;

/**
 * `linear()` sampled from a damped spring (stiffness 380, damping 32, mass 1): overshoot
 * about 1 %, well under the 4 % limit. Falls back to ease-out where `linear()` is unsupported.
 */
export function easeSpring(): string {
  const token = readVar("--ease-spring");
  if (token) return token;
  if (springCache) return springCache;
  const supported = typeof CSS !== "undefined" && CSS.supports?.("animation-timing-function", "linear(0, 1)");
  if (!supported) return (springCache = EASE_OUT_FALLBACK);
  const stiffness = 380;
  const damping = 32;
  const points: string[] = [];
  let position = 0;
  let velocity = 0;
  const steps = 40;
  const total = 0.6; // seconds of simulated time mapped onto the animation duration
  const dt = total / steps / 20;
  for (let step = 0; step <= steps; step += 1) {
    points.push(position.toFixed(4));
    for (let tick = 0; tick < 20; tick += 1) {
      const force = -stiffness * (position - 1) - damping * velocity;
      velocity += force * dt;
      position += velocity * dt;
    }
  }
  points[points.length - 1] = "1";
  return (springCache = `linear(${points.join(", ")})`);
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function canAnimate(element: Element | null | undefined): element is HTMLElement {
  return Boolean(element && typeof (element as HTMLElement).animate === "function");
}

/** Reduced motion: a short fade instead of movement. */
export function fadeIn(element: Element | null | undefined, ms = 120): Animation | null {
  if (!canAnimate(element)) return null;
  return element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: Math.min(ms, 120), easing: "linear" });
}

export function toRect(domRect: DOMRect): Rect {
  return { left: domRect.left, top: domRect.top, width: domRect.width, height: domRect.height };
}

/** «Поп» of a successful action: scale up a little and back (≤ 400 ms). */
export function pop(element: Element | null | undefined, scale = 1.12): void {
  if (!canAnimate(element) || prefersReducedMotion()) return;
  element.animate(
    [{ transform: "scale(1)" }, { transform: `scale(${scale})`, offset: 0.4 }, { transform: "scale(1)" }],
    { duration: motionMs("--motion-slow"), easing: easeOut() },
  );
}

/** ♡: the heart fills with a pop and up to six particles (none with reduced motion). */
export function heartBurst(element: Element | null | undefined, color: string): void {
  if (!canAnimate(element)) return;
  if (prefersReducedMotion()) return;
  pop(element, 1.28);
  const rect = element.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  for (let index = 0; index < 6; index += 1) {
    const particle = document.createElement("span");
    particle.className = "g-particle";
    particle.setAttribute("aria-hidden", "true");
    particle.style.left = `${cx - 3}px`;
    particle.style.top = `${cy - 3}px`;
    particle.style.background = color;
    document.body.append(particle);
    const angle = (Math.PI * 2 * index) / 6 - Math.PI / 2;
    const distance = 22 + (index % 2) * 6;
    const animation = particle.animate(
      [
        { transform: "translate(0, 0) scale(1)", opacity: 1 },
        { transform: `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance}px) scale(0.4)`, opacity: 0 },
      ],
      { duration: 380, easing: easeOut() },
    );
    animation.onfinish = () => particle.remove();
    animation.oncancel = () => particle.remove();
  }
}

/**
 * «В мой выбор»: a thumbnail flies along an arc from `from` to the «Мой выбор» bar
 * (≤ 360 ms). Purely decorative: the bar is already updated.
 */
export function flyToBar(from: Rect, image: string | null, fallbackColor: string): Promise<void> {
  if (prefersReducedMotion() || typeof document === "undefined") return Promise.resolve();
  const target = document.querySelector<HTMLElement>(".g-choice-bar__button svg, .g-choice-bar__button");
  if (!target) return Promise.resolve();
  const end = target.getBoundingClientRect();
  const size = 44;
  const ghost = document.createElement(image ? "img" : "span");
  ghost.className = "g-flight";
  ghost.setAttribute("aria-hidden", "true");
  if (image) (ghost as HTMLImageElement).src = image;
  else ghost.style.background = fallbackColor;
  const startX = from.left + from.width / 2 - size / 2;
  const startY = from.top + from.height / 2 - size / 2;
  const endX = end.left + end.width / 2 - size / 2;
  const endY = end.top + end.height / 2 - size / 2;
  ghost.style.left = `${startX}px`;
  ghost.style.top = `${startY}px`;
  document.body.append(ghost);
  const dx = endX - startX;
  const dy = endY - startY;
  const lift = Math.min(120, Math.abs(dx) * 0.4 + 60);
  const animation = ghost.animate(
    [
      { transform: "translate(0, 0) scale(1)", opacity: 1 },
      { transform: `translate(${dx * 0.5}px, ${Math.min(dy * 0.5, 0) - lift}px) scale(0.8)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0.2 },
    ],
    { duration: motionMs("--motion-slow"), easing: "cubic-bezier(0.3, 0, 0.2, 1)" },
  );
  return new Promise((resolve) => {
    const done = () => {
      ghost.remove();
      resolve();
    };
    animation.onfinish = done;
    animation.oncancel = done;
  });
}

/** The bar's count «подпрыгивает» when something is added. */
export function bumpBar(): void {
  pop(document.querySelector(".g-choice-bar__button"), 1.05);
}

/**
 * Moves an absolutely positioned indicator (chip background, size highlight) to `target`
 * inside `container` with FLIP: transform only, interruptible (starts from where it is).
 */
export function slideIndicator(indicator: HTMLElement | null, container: HTMLElement | null, target: HTMLElement | null, animate: boolean): void {
  if (!indicator || !container || !target) {
    if (indicator) indicator.style.opacity = "0";
    return;
  }
  const box = container.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  const x = rect.left - box.left + container.scrollLeft;
  const y = rect.top - box.top + container.scrollTop;
  const before = indicator.getBoundingClientRect();
  const hadPosition = indicator.dataset.placed === "1";
  indicator.getAnimations().forEach((running) => running.cancel());
  indicator.style.width = `${rect.width}px`;
  indicator.style.height = `${rect.height}px`;
  indicator.style.transform = `translate(${x}px, ${y}px)`;
  indicator.style.opacity = "1";
  indicator.dataset.placed = "1";
  if (!animate || !hadPosition || prefersReducedMotion() || !canAnimate(indicator)) return;
  const after = indicator.getBoundingClientRect();
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  const sx = after.width ? before.width / after.width : 1;
  const sy = after.height ? before.height / after.height : 1;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01) return;
  indicator.animate(
    [
      { transform: `translate(${x + dx}px, ${y + dy}px) scale(${sx}, ${sy})` },
      { transform: `translate(${x}px, ${y}px) scale(1, 1)` },
    ],
    { duration: motionMs("--motion-base"), easing: easeSpring() },
  );
}
