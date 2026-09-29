// Motion utilities of «Синица» on the Web Animations API — no dependencies.
// Durations and curves come from the tokens in tokens.css (`--motion-*`, `--ease-*`,
// `--stagger`), so changing a token changes every animation. Only `transform` and `opacity`
// are animated (plus `clip-path` for the shared element of a sheet). Every helper is
// interruptible (a new call cancels the previous animation of the element) and, with
// `prefers-reduced-motion: reduce`, degrades to an instant change: nothing moves or scales.

export type MotionDuration = "instant" | "fast" | "base" | "slow";
export type MotionEasing = "out" | "in" | "spring";

const FALLBACK_MS: Record<MotionDuration, number> = { instant: 80, fast: 140, base: 240, slow: 360 };
const FALLBACK_EASING: Record<MotionEasing, string> = {
  out: "cubic-bezier(0.2, 0, 0, 1)",
  in: "cubic-bezier(0.4, 0, 1, 1)",
  spring: "cubic-bezier(0.2, 0, 0, 1)",
};
/** At most this many elements take part in a cascade; the rest appear at once. */
export const MAX_CASCADE = 8;

function rootStyle(): CSSStyleDeclaration | null {
  try {
    return typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
  } catch {
    return null;
  }
}

function parseTime(value: string): number | null {
  const text = value.trim();
  const match = /^(-?[\d.]+)(ms|s)$/.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  return Number.isFinite(amount) ? amount * (match[2] === "s" ? 1000 : 1) : null;
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Duration token in milliseconds (0 with reduced motion). */
export function motionMs(token: MotionDuration): number {
  if (prefersReducedMotion()) return 0;
  return parseTime(rootStyle()?.getPropertyValue(`--motion-${token}`) ?? "") ?? FALLBACK_MS[token];
}

/** `--stagger` in milliseconds (0 with reduced motion). */
export function staggerMs(): number {
  if (prefersReducedMotion()) return 0;
  return parseTime(rootStyle()?.getPropertyValue("--stagger") ?? "") ?? 30;
}

let linearSupported: boolean | null = null;
function supportsLinear(): boolean {
  if (linearSupported === null) {
    try {
      linearSupported = typeof CSS !== "undefined" && CSS.supports("transition-timing-function", "linear(0, 1)");
    } catch {
      linearSupported = false;
    }
  }
  return linearSupported;
}

/** Easing token as a string the Web Animations API accepts. */
export function motionEasing(name: MotionEasing): string {
  const value = rootStyle()?.getPropertyValue(`--ease-${name}`).trim().replace(/\s+/g, " ");
  if (!value || value.startsWith("var(")) return FALLBACK_EASING[name];
  if (value.startsWith("linear(") && !supportsLinear()) return FALLBACK_EASING[name];
  return value;
}

export interface MotionOptions {
  duration?: MotionDuration | number;
  easing?: MotionEasing;
  delay?: number;
  fill?: FillMode;
}

const running = new WeakMap<Element, Animation>();

/**
 * Plays keyframes on an element, cancelling its previous helper animation first (so a new
 * action interrupts the old one). Returns null when nothing is played: reduced motion,
 * zero duration or no Web Animations API.
 */
export function play(element: Element | null | undefined, keyframes: Keyframe[], options: MotionOptions = {}): Animation | null {
  if (!element || typeof (element as HTMLElement).animate !== "function") return null;
  running.get(element)?.cancel();
  const duration = typeof options.duration === "number"
    ? (prefersReducedMotion() ? 0 : options.duration)
    : motionMs(options.duration ?? "base");
  if (duration <= 0) return null;
  const animation = (element as HTMLElement).animate(keyframes, {
    duration,
    easing: motionEasing(options.easing ?? "out"),
    delay: options.delay ?? 0,
    fill: options.fill ?? "backwards",
  });
  running.set(element, animation);
  const forget = () => { if (running.get(element) === animation) running.delete(element); };
  animation.finished.then(forget, forget);
  return animation;
}

/** Resolves when the animation ends or is cancelled; immediately for `null`. */
export function settled(animation: Animation | null): Promise<void> {
  return animation ? animation.finished.then(() => undefined, () => undefined) : Promise.resolve();
}

// --- FLIP ---------------------------------------------------------------------------------

export type Snapshot = Map<Element, DOMRect>;

/** First step of FLIP: remember where the elements are now. */
export function measure(elements: Iterable<Element>): Snapshot {
  const snapshot: Snapshot = new Map();
  for (const element of elements) snapshot.set(element, element.getBoundingClientRect());
  return snapshot;
}

/**
 * Last-Invert-Play: every element of `elements` that was measured slides from its old place
 * to its new one; elements that were not measured (just added) grow in — fade and a short
 * drop — while their neighbours move smoothly instead of jumping.
 */
export function flip(before: Snapshot, elements: Iterable<Element>, options: MotionOptions = {}): void {
  if (prefersReducedMotion()) return;
  for (const element of elements) {
    const first = before.get(element);
    if (!first) {
      play(element, [
        { opacity: 0, transform: "translateY(-8px) scale(0.98)" },
        { opacity: 1, transform: "none" },
      ], { duration: options.duration ?? "base", easing: options.easing ?? "spring" });
      continue;
    }
    const last = element.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    play(element, [
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: "none" },
    ], { duration: options.duration ?? "base", easing: options.easing ?? "spring" });
  }
}

// --- Cascades, feedback -------------------------------------------------------------------

/** Appearance cascade: the first MAX_CASCADE elements with `--stagger`, the rest at once. */
export function stagger(elements: ArrayLike<Element>, keyframes: Keyframe[] = [
  { opacity: 0, transform: "translateY(8px)" },
  { opacity: 1, transform: "none" },
], options: MotionOptions = {}): void {
  const step = staggerMs();
  Array.from(elements).slice(0, MAX_CASCADE).forEach((element, index) => {
    play(element, keyframes, { duration: "base", easing: "out", ...options, delay: (options.delay ?? 0) + index * step });
  });
}

/** Error: two short horizontal cycles. */
export function shake(element: Element | null | undefined): Animation | null {
  const distance = 6;
  return play(element, [
    { transform: "translateX(0)" },
    { transform: `translateX(-${distance}px)` },
    { transform: `translateX(${distance}px)` },
    { transform: `translateX(-${distance}px)` },
    { transform: `translateX(${distance}px)` },
    { transform: "translateX(0)" },
  ], { duration: "slow", easing: "out" });
}

/** Success «pop»: a short scale-up and back. */
export function pop(element: Element | null | undefined): Animation | null {
  return play(element, [
    { transform: "scale(1)" },
    { transform: "scale(1.18)", offset: 0.4 },
    { transform: "scale(1)" },
  ], { duration: "base", easing: "spring" });
}

// --- Fly to target ------------------------------------------------------------------------

/**
 * A copy of `source` flies along an arc to `target` (≤ --motion-slow) and the target pops.
 * The copy is decorative (aria-hidden, no pointer events) and removed afterwards.
 */
export function flyToTarget(source: Element | null | undefined, target: Element | null | undefined): Promise<void> {
  if (!source || !target || prefersReducedMotion() || typeof document === "undefined") return Promise.resolve();
  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (!from.width || !to.width) return Promise.resolve();
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.setAttribute("aria-hidden", "true");
  ghost.removeAttribute("id");
  Object.assign(ghost.style, {
    position: "fixed", left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`,
    margin: "0", pointerEvents: "none", zIndex: "80", transformOrigin: "top left",
  });
  document.body.append(ghost);
  const scale = Math.max(0.2, Math.min(to.width / from.width, to.height / from.height));
  const dx = to.left + to.width / 2 - (from.left + (from.width * scale) / 2);
  const dy = to.top + to.height / 2 - (from.top + (from.height * scale) / 2);
  const lift = Math.min(120, Math.abs(dy) / 2 + 40);
  const animation = play(ghost, [
    { transform: "translate(0, 0) scale(1)", opacity: 1 },
    { transform: `translate(${dx / 2}px, ${dy / 2 - lift}px) scale(${(1 + scale) / 2})`, opacity: 1, offset: 0.5 },
    { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.4 },
  ], { duration: "slow", easing: "in", fill: "forwards" });
  return settled(animation).then(() => {
    ghost.remove();
    pop(target);
  });
}

// --- Shared element -----------------------------------------------------------------------

function rectOf(origin: Element | DOMRect): DOMRect {
  return origin instanceof Element ? origin.getBoundingClientRect() : origin;
}

function sharedKeyframes(origin: DOMRect, target: HTMLElement): Keyframe[] | null {
  const rect = target.getBoundingClientRect();
  if (!rect.width || !rect.height || !origin.width || !origin.height) return null;
  const dx = origin.left - rect.left;
  const dy = origin.top - rect.top;
  const right = Math.max(0, rect.width - origin.width);
  const bottom = Math.max(0, rect.height - origin.height);
  const radius = getComputedStyle(target).borderTopLeftRadius || "0px";
  return [
    { transform: `translate(${dx}px, ${dy}px)`, clipPath: `inset(0px ${right}px ${bottom}px 0px round 16px)` },
    { transform: "translate(0px, 0px)", clipPath: `inset(0px 0px 0px 0px round ${radius})` },
  ];
}

/**
 * Shared element «откуда → куда»: `target` (already at its final place) starts as the box of
 * `origin` — moved there and clipped to its size — and opens to its own box. Content is not
 * scaled, so text never distorts. Returns null when there is nothing to morph.
 */
export function morphFrom(origin: Element | DOMRect | null | undefined, target: HTMLElement | null | undefined): Animation | null {
  if (!origin || !target || prefersReducedMotion()) return null;
  const keyframes = sharedKeyframes(rectOf(origin), target);
  return keyframes ? play(target, keyframes, { duration: "slow", easing: "spring" }) : null;
}

/** Reverse of `morphFrom`: `target` shrinks back into the box of `origin`. */
export function morphTo(origin: Element | DOMRect | null | undefined, target: HTMLElement | null | undefined): Animation | null {
  if (!origin || !target || prefersReducedMotion()) return null;
  if (origin instanceof Element && !origin.isConnected) return null;
  const keyframes = sharedKeyframes(rectOf(origin), target);
  return keyframes
    ? play(target, [...keyframes].reverse().map((frame) => ({ ...frame, opacity: 1 })), { duration: "base", easing: "in", fill: "forwards" })
    : null;
}
