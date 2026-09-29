import { useQuery } from "@tanstack/react-query";
import { Camera, Check, ChevronRight, Coffee, ListPlus, MessageSquareText } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import type { MenuItem, MenuSection } from "../../../api/menu";
import { fetchSiteDraft } from "../../../api/site";
import { stagger } from "../../../design/motion";

interface StartChoice {
  key: string;
  title: string;
  hint: string;
  icon: ReactNode;
  onSelect: () => void;
  busy?: boolean;
}

/**
 * «Как начнём?»: an empty menu offers four ways
 * to start. Every way writes only to the draft; the checklist below leads to publication.
 */
export function MenuStart({ onPhoto, onDescribe, onTemplate, onManual, templateBusy, error }: {
  onPhoto: (() => void) | null;
  onDescribe: (() => void) | null;
  onTemplate: () => void;
  onManual: () => void;
  templateBusy: boolean;
  error: string | null;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  // First assembly: the choices arrive one after another.
  useEffect(() => {
    if (listRef.current) stagger(listRef.current.children);
  }, []);
  const choices: StartChoice[] = [
    ...(onPhoto ? [{ key: "photo", title: "Сфотографировать меню", hint: "Распознаем позиции и цены — вы проверите", icon: <Camera size={22} />, onSelect: onPhoto }] : []),
    ...(onDescribe ? [{ key: "ai", title: "Описать словами", hint: "«Капучино 190, латте 210…»", icon: <MessageSquareText size={22} />, onSelect: onDescribe }] : []),
    { key: "template", title: "Шаблон кофейни", hint: "10 популярных позиций — останется поставить цены", icon: <Coffee size={22} />, onSelect: onTemplate, busy: templateBusy },
    { key: "manual", title: "Вручную", hint: "Раздел за разделом, строкой «Латте 190»", icon: <ListPlus size={22} />, onSelect: onManual },
  ];
  return (
    <section className="menu-start" aria-labelledby="menu-start-title">
      <h2 id="menu-start-title">Как начнём?</h2>
      <ul className="cabinet-list menu-start__list" ref={listRef}>
        {choices.map((choice) => (
          <li key={choice.key}>
            <button type="button" className="cabinet-list__row" onClick={choice.onSelect} disabled={choice.busy} aria-busy={choice.busy || undefined}>
              <span className="cabinet-list__icon" aria-hidden="true">{choice.icon}</span>
              <span className="cabinet-list__text"><strong>{choice.title}</strong><small>{choice.hint}</small></span>
              <ChevronRight size={20} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="cabinet-error" role="alert">{error}</p>}
    </section>
  );
}

export function hasPrice(item: MenuItem): boolean {
  const variants = item.configuration?.variants ?? [];
  return variants.length ? variants.some((variant) => variant.is_available && variant.price_minor > 0) : item.price_minor > 0;
}

const QR_SEEN = (pointId: string) => `sinitsa:qr-seen:${pointId}`;

export function markQrSeen(pointId: string): void {
  try {
    window.localStorage.setItem(QR_SEEN(pointId), "1");
  } catch {
    // Private mode: the step simply stays open.
  }
}

function qrSeen(pointId: string): boolean {
  try {
    return window.localStorage.getItem(QR_SEEN(pointId)) === "1";
  } catch {
    return false;
  }
}

/**
 * «До публикации» checklist: positions → prices → design → publication → QR,
 * computed from the real draft, the site draft and the publication; hidden once all is done.
 */
export function StartChecklist({ pointId, sections, published, onStep }: {
  pointId: string;
  sections: MenuSection[];
  published: boolean;
  onStep: (step: "items" | "prices" | "design" | "publish" | "qr") => void;
}) {
  const site = useQuery({ queryKey: ["site-draft", pointId], queryFn: () => fetchSiteDraft(pointId), retry: false });
  const items = sections.flatMap((section) => section.items).filter((item) => item.is_available);
  const unpriced = items.filter((item) => !hasPrice(item)).length;
  const steps = [
    { key: "items" as const, title: "Позиции", done: items.length > 0, hint: items.length ? `${items.length} в меню` : "Добавьте хотя бы одну" },
    { key: "prices" as const, title: "Цены", done: items.length > 0 && unpriced === 0, hint: unpriced ? `Без цены: ${unpriced}` : "Поставьте цены" },
    { key: "design" as const, title: "Оформление", done: Boolean(site.data && (site.data.published_version > 0)), hint: "Тема и цвета заведения" },
    { key: "publish" as const, title: "Публикация", done: published, hint: published ? "Гости видят меню" : "Меню увидят гости" },
    { key: "qr" as const, title: "QR на столы", done: published && qrSeen(pointId), hint: "Распечатайте тейбл-тент" },
  ];
  const done = steps.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done)?.key;
  if (done === steps.length) return null;
  return (
    <section className="menu-checklist" aria-labelledby="menu-checklist-title">
      <header>
        <h2 id="menu-checklist-title">До запуска</h2>
        <span className="menu-checklist__count">{done} из {steps.length}</span>
      </header>
      <div className="menu-checklist__bar" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done} aria-label="Готовность меню">
        <span style={{ transform: `scaleX(${done / steps.length})` }} />
      </div>
      <ol>
        {steps.map((step) => (
          <li key={step.key} className={step.done ? "is-done" : step.key === next ? "is-next" : undefined}>
            <button type="button" onClick={() => onStep(step.key)} disabled={step.done}>
              <span className="menu-checklist__mark" aria-hidden="true">{step.done ? <Check size={14} /> : null}</span>
              <span className="menu-checklist__text"><strong>{step.title}</strong><small>{step.done ? "Готово" : step.hint}</small></span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
