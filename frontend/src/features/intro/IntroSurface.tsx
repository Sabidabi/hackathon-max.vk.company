import { ChevronLeft, Coffee, Store } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { finishIntro, rememberIntroSeen } from "../../app/intro";
import { Button, IconButton } from "../../design";
import { morphFrom, play, prefersReducedMotion, settled, stagger } from "../../design/motion";
import { getMaxBridge, haptics, useBackButton } from "../../max";
import { BrandDemo, GuestDemo, OwnerDemo } from "./IntroDemos";
import "./intro.css";

// Seeded by `backend/app/demo_data.py` (DEMO_PUBLIC_ID).
const DEMO_PATH = "/r/demo-sever";

const STEPS = [
  { title: "Меню кофейни прямо в MAX", text: "Гости выбирают быстрее. Вы меняете меню за минуту.", Demo: BrandDemo },
  { title: "Гостю — QR, выбор, касса", text: "Сканируйте QR, соберите напиток и покажите выбор на кассе.", Demo: GuestDemo },
  { title: "Заведению — меню за минуты", text: "Стоп-лист одним тапом, QR сразу после публикации.", Demo: OwnerDemo },
] as const;
const LAST = STEPS.length - 1;
const SWIPE_PX = 56;

/**
 * «Что умеет Синица»: full-screen intro before Home on the first launch in MAX
 * (`mode="first"`, flag in DeviceStorage) and again from Home (`/intro`, `mode="replay"`).
 * Three short steps on one persistent brand stage whose content morphs between steps; the
 * guest and owner steps are live mini-demos on real components. One main button per step,
 * «Пропустить» always visible; swipe, arrows and MAX «Назад» move between steps.
 */
export default function IntroSurface({ mode }: { mode: "first" | "replay" }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [step, setStep] = useState(0);
  const direction = useRef(0);
  const root = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const ghosts = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const inMax = Boolean(getMaxBridge());

  // The flag is written as soon as the intro is seen, so closing MAX mid-way does not repeat it.
  useEffect(() => {
    if (mode === "first") rememberIntroSeen();
  }, [mode]);

  function leave(to: string | null) {
    if (mode === "first") finishIntro();
    if (to) navigate(to);
    else if (mode === "replay") {
      if ((location.state as { from?: string } | null)?.from === "home") navigate(-1);
      else navigate("/home", { replace: true });
    }
  }

  function go(next: number) {
    const target = Math.max(0, Math.min(LAST, next));
    if (target === step) return;
    haptics.selection();
    direction.current = target > step ? 1 : -1;
    leaveStage(direction.current);
    setStep(target);
  }

  // The outgoing demo is copied into a decorative layer and slides out while the next one
  // slides in, so the stage morphs instead of blinking empty. Rapid taps just stack copies.
  function leaveStage(dir: number) {
    const current = stage.current?.querySelector(".intro-stage__content");
    const layer = ghosts.current;
    if (!current || !layer || prefersReducedMotion()) return;
    const ghost = current.cloneNode(true) as HTMLElement;
    ghost.setAttribute("aria-hidden", "true");
    ghost.setAttribute("inert", "");
    ghost.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
    layer.append(ghost);
    const animation = play(ghost, [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: `translateX(${dir * -40}px) scale(0.96)` },
    ], { duration: "base", easing: "out", fill: "forwards" });
    void settled(animation).then(() => ghost.remove());
  }

  // Choreography: the stage content morphs in from the side of travel on a spring,
  // then copy and actions cascade with --stagger. Each call cancels the running one.
  useLayoutEffect(() => {
    const dir = direction.current;
    const content = stage.current?.querySelector(".intro-stage__content");
    if (dir) {
      play(content, [
        { opacity: 0, transform: `translateX(${dir * 40}px) scale(0.94)` },
        { opacity: 1, transform: "none" },
      ], { duration: "slow", easing: "spring" });
    } else if (stage.current) {
      // First appearance: the stage grows out of the app icon of the splash screen
      // (88 px in the middle of the screen) — the brand mark becomes the intro.
      const icon = 88;
      morphFrom(new DOMRect((window.innerWidth - icon) / 2, (window.innerHeight - icon) / 2, icon, icon), stage.current);
    }
    const inner = stage.current?.querySelectorAll(".intro-stage__content [data-enter]") ?? [];
    stagger(inner, [{ opacity: 0, transform: "translateY(12px) scale(0.96)" }, { opacity: 1, transform: "none" }], { delay: dir ? 90 : 220, easing: "spring" });
    const copy = root.current?.querySelectorAll(".intro-copy [data-enter]") ?? [];
    stagger(copy, [
      { opacity: 0, transform: dir ? `translateX(${dir * 24}px)` : "translateY(8px)" },
      { opacity: 1, transform: "none" },
    ], { delay: dir ? 40 : 180 });
    if (dir) heading.current?.focus({ preventScroll: true });
  }, [step]);

  // MAX «Назад»: previous step; on the first step it closes a replay (the first launch has no «back»).
  useBackButton(step > 0 ? () => go(step - 1) : mode === "replay" ? () => leave(null) : null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") go(step + 1);
      if (event.key === "ArrowLeft") go(step - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function onPointerDown(event: ReactPointerEvent) {
    const target = event.target as Element;
    // Controls of the live demo keep their own gestures.
    swipe.current = target.closest(".intro-stage button, [role=switch]") ? null : { x: event.clientX, y: event.clientY };
  }
  function onPointerUp(event: ReactPointerEvent) {
    const start = swipe.current;
    swipe.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) go(step + (dx < 0 ? 1 : -1));
  }

  const { title, text, Demo } = STEPS[step];
  return (
    <main
      ref={root}
      className="intro"
      aria-roledescription="интро"
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => { swipe.current = null; }}
    >
      <header className="intro-bar">
        {!inMax && (step > 0
          ? <IconButton aria-label="Назад" icon={<ChevronLeft size={24} />} onClick={() => go(step - 1)} />
          : <span className="intro-bar__spacer" aria-hidden="true" />)}
        <div className="intro-progress" role="img" aria-label={`Шаг ${step + 1} из ${STEPS.length}`}>
          {STEPS.map((item, index) => (
            <span key={item.title} className={`intro-progress__seg${index <= step ? " intro-progress__seg--on" : ""}`} />
          ))}
        </div>
        <Button variant="ghost" className="intro-skip" onClick={() => { haptics.selection(); leave(null); }}>
          Пропустить
        </Button>
      </header>

      <div className="intro-stage" ref={stage} aria-live="off">
        <div className="intro-stage__content" key={step}><Demo /></div>
        <div className="intro-stage__ghosts" ref={ghosts} aria-hidden="true" />
      </div>

      <section className="intro-copy" key={step} aria-labelledby="intro-title">
        <div className="intro-copy__text-block">
          <h1 id="intro-title" ref={heading} tabIndex={-1} className="intro-copy__title" data-enter>{title}</h1>
          <p className="intro-copy__text" data-enter>{text}</p>
        </div>
        <div className="intro-copy__actions" data-enter>
          {step < LAST ? (
            <Button fullWidth onClick={() => go(step + 1)}>{step === 0 ? "Начать" : "Дальше"}</Button>
          ) : (
            <>
              <Button fullWidth icon={<Coffee size={20} />} onClick={() => { haptics.impact("medium"); leave(DEMO_PATH); }}>
                Посмотреть демо-меню
              </Button>
              <Button fullWidth variant="secondary" icon={<Store size={20} />} onClick={() => { haptics.impact("light"); leave("/connect"); }}>
                Подключить заведение
              </Button>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
