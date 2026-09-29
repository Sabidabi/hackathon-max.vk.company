import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ListPlus, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { trackAdmin } from "../../analytics";
import { applyImportReview, fetchImportReview, type ImportJob, type ReviewItem, type ReviewSection } from "../../api/imports";
import { Button, EmptyState, IconButton, Sheet, Skeleton, TextInput } from "../../design";
import { showToast } from "../../design/toast";
import { haptics } from "../../max";
import { parsePrice } from "../menu/PriceInput";

/** Below this the field is highlighted «Проверьте». */
const DOUBT = 0.7;

const emptyItem = (): ReviewItem => ({
  name: "Новая позиция",
  price_minor: 0,
  currency: "RUB",
  weight_text: null,
  description: null,
  description_source: null,
  source_line: null,
  source_confidence: null,
  price_missing: true,
  field_confidence: null,
  variants: [],
});

const FALLBACK_NOTES: Record<string, string> = {
  unavailable: "ИИ недоступен — меню распознано без ИИ, проверьте внимательнее",
  limit: "Лимит ИИ на сегодня исчерпан — распознано без ИИ",
  too_long: "Меню слишком большое для ИИ — распознано без ИИ",
  disabled: "ИИ-разбор выключен — меню распознано без ИИ",
  empty: "В документе нет текста для ИИ — распознано без ИИ",
  no_items: "ИИ не нашёл позиций — распознано без ИИ",
  no_venue: "ИИ недоступен — меню распознано без ИИ",
};

const rubles = (minor: number) => String(minor / 100);

export function nameInDoubt(item: ReviewItem): boolean {
  const name = item.field_confidence?.name ?? item.source_confidence;
  return name !== null && name !== undefined && name < DOUBT;
}

/** Two or more sizes: the server keeps the sizes and hides the ones without a price. */
export function isSized(item: ReviewItem): boolean {
  return (item.variants?.length ?? 0) >= 2;
}

export function priceInDoubt(item: ReviewItem): boolean {
  if (item.price_missing) return true;
  const price = item.field_confidence?.price ?? item.source_confidence;
  return price !== null && price !== undefined && price < DOUBT;
}

function trackImportApplied(detail: Record<string, unknown>) {
  try {
    window.dispatchEvent(new CustomEvent("sinitsa:event", { detail: { name: "import_applied", ...detail } }));
  } catch {
    // Events are best effort.
  }
}

/** Rouble text field over integer kopecks; empty text = «нет цены» (never silently 0 ₽). */
function ReviewPrice({ label, minor, missing, doubt, emptyHint, onChange }: {
  label: string;
  minor: number;
  missing: boolean;
  doubt: boolean;
  /** What the server does with an empty price: a position is blocked, a size is hidden. */
  emptyHint: string;
  onChange: (minor: number, missing: boolean) => void;
}) {
  const [text, setText] = useState(missing && !minor ? "" : rubles(minor));
  const parsed = text.trim() ? parsePrice(text) : null;
  const invalid = Boolean(text.trim()) && parsed === null;
  return (
    <div className={doubt ? "review-field review-field--doubt" : "review-field"}>
      <TextInput
        label={label}
        inputMode="decimal"
        maxLength={11}
        placeholder="Проверьте цену"
        value={text}
        error={invalid ? "Например, 190 или 190,50" : undefined}
        hint={!text.trim() ? emptyHint : doubt ? "Проверьте цену" : undefined}
        onChange={(event) => {
          setText(event.target.value);
          const next = event.target.value.trim() ? parsePrice(event.target.value) : null;
          onChange(next ?? 0, next === null);
        }}
      />
    </div>
  );
}

/**
 * Review of a recognised menu: doubtful fields are highlighted, everything can be
 * fixed or deleted, «Применить в черновик» replaces the draft and never publishes. Positions
 * without a price go to the draft too — publication stays blocked until a price is entered;
 * a size without a price becomes unavailable (backend imports.py), the position still publishes.
 */
export function ImportReview({ restaurantId, importId, onClose }: {
  restaurantId: string;
  importId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [sections, setSections] = useState<ReviewSection[]>([]);
  const review = useQuery({
    queryKey: ["import-review", restaurantId, importId],
    queryFn: () => fetchImportReview(restaurantId, importId!),
    enabled: Boolean(importId),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    if (review.data) setSections(structuredClone(review.data.sections));
  }, [review.data]);

  const applyReview = useMutation({
    mutationFn: () => applyImportReview(restaurantId, importId!, sections, review.data!.draft_revision),
    onSuccess: (result) => {
      haptics.notify("success");
      trackAdmin("import_applied", { count: result.item_count });
      queryClient.setQueryData<ImportJob[]>(["imports", restaurantId], (jobs = []) =>
        jobs.map((job) => (job.id === importId ? { ...job, status: "completed", progress: 100, item_count: result.item_count } : job)));
      void queryClient.invalidateQueries({ queryKey: ["menu-draft"] });
      void queryClient.invalidateQueries({ queryKey: ["venue-menus"] });
      trackImportApplied({ restaurant_id: restaurantId, items: result.item_count, parser: review.data?.parser ?? null });
      showToast(`В черновике ${result.item_count} позиций — проверьте и опубликуйте`, { tone: "success" });
      onClose();
    },
    onError: () => haptics.notify("error"),
  });

  const updateSection = (index: number, patch: Partial<ReviewSection>) =>
    setSections((current) => current.map((section, at) => (at === index ? { ...section, ...patch } : section)));
  const updateItem = (sectionIndex: number, itemIndex: number, patch: Partial<ReviewItem>) =>
    setSections((current) => current.map((section, at) => (at === sectionIndex
      ? { ...section, items: section.items.map((item, i) => (i === itemIndex ? { ...item, ...patch } : item)) }
      : section)));
  const removeItem = (sectionIndex: number, itemIndex: number) => {
    const before = sections;
    const name = sections[sectionIndex]?.items[itemIndex]?.name ?? "";
    setSections((current) => current
      .map((section, at) => (at === sectionIndex ? { ...section, items: section.items.filter((_, i) => i !== itemIndex) } : section))
      .filter((section) => section.items.length > 0));
    showToast(`«${name}» убрана из импорта`, { action: { label: "Отменить", onClick: () => setSections(before) } });
  };

  const stats = useMemo(() => {
    const items = sections.flatMap((section) => section.items);
    return {
      items: items.length,
      doubts: items.filter((item) => nameInDoubt(item) || priceInDoubt(item)).length,
      // Blocked from publication: no price at all (sized positions — no priced size).
      noPrice: items.filter((item) => (isSized(item)
        ? !item.variants!.some((variant) => variant.price_minor > 0)
        : item.price_missing || item.price_minor === 0)).length,
      // Sizes without a price in otherwise priced positions: hidden from guests.
      hiddenSizes: items
        .filter((item) => isSized(item) && item.variants!.some((variant) => variant.price_minor > 0))
        .reduce((count, item) => count + item.variants!.filter((variant) => !variant.price_minor).length, 0),
    };
  }, [sections]);
  const invalid = !sections.length || sections.some((section) => !section.name.trim() || section.items.some((item) => !item.name.trim()));
  const byAi = review.data?.parser === "llm-v1";

  return (
    <Sheet
      open={Boolean(importId)}
      onClose={onClose}
      wide
      title="Проверьте распознанное меню"
      closeLabel="Закрыть проверку"
      footer={review.data ? (
        <>
          <span className="item-footer__status" role="status">
            {invalid
              ? "Заполните названия"
              : stats.noPrice
                ? `Без цены: ${stats.noPrice} — их не опубликовать`
                : stats.hiddenSizes
                  ? `Размеров без цены: ${stats.hiddenSizes} — будут скрыты`
                  : "Заменит черновик, гости не увидят до публикации"}
          </span>
          <Button disabled={invalid} loading={applyReview.isPending} onClick={() => applyReview.mutate()}>Применить в черновик</Button>
        </>
      ) : undefined}
    >
      {review.isPending && (
        <div className="review-loading" aria-busy="true" aria-label="Загружаем распознанное меню">
          {[0, 1, 2, 3].map((row) => <Skeleton key={row} height={72} radius="control" />)}
        </div>
      )}
      {review.isError && (
        <EmptyState icon={<AlertTriangle size={28} />} tone="danger" title="Не удалось открыть результат" action={<Button variant="secondary" onClick={() => void review.refetch()}>Попробовать снова</Button>}>
          {review.error.message}
        </EmptyState>
      )}
      {review.data && (
        <div className="review">
          <p className="review-summary">
            <span className={byAi ? "review-badge review-badge--ai" : "review-badge"}>
              {byAi ? <><Sparkles size={14} aria-hidden="true" />{review.data.provider === "mock" ? "Демо-ИИ" : "Разобрано ИИ"}</> : "Без ИИ"}
            </span>
            {stats.items} позиций{stats.doubts ? ` · проверьте ${stats.doubts}` : ""}
          </p>
          {review.data.ai_fallback && (
            <p className="review-note" role="note">{FALLBACK_NOTES[review.data.ai_fallback] ?? "Меню распознано без ИИ"}</p>
          )}
          {sections.some((section) => section.items.some((item) => item.description_source === "ai")) && (
            <p className="review-note" role="note"><Sparkles size={14} aria-hidden="true" /> Описания без текста в меню предложил ИИ — проверьте</p>
          )}
          {review.data.unparsed_lines.length > 0 && (
            <details className="review-unparsed">
              <summary>Не распределили строк: {review.data.unparsed_lines.length}</summary>
              <ul>{review.data.unparsed_lines.slice(0, 20).map((line, index) => <li key={`${line}-${index}`}>{line}</li>)}</ul>
            </details>
          )}
          {applyReview.isError && <p className="cabinet-error" role="alert">{applyReview.error.message}</p>}
          {sections.map((section, sectionIndex) => (
            <section key={`section-${sectionIndex}`} className="review-section" aria-label={`Раздел ${section.name || "без названия"}`}>
              <TextInput label="Раздел" maxLength={200} value={section.name} error={section.name.trim() ? undefined : "Назовите раздел"} onChange={(event) => updateSection(sectionIndex, { name: event.target.value })} />
              <ul className="review-items">
                {section.items.map((item, itemIndex) => {
                  const nameDoubt = nameInDoubt(item);
                  const priceDoubt = priceInDoubt(item);
                  const sized = isSized(item);
                  return (
                    <li key={`item-${sectionIndex}-${itemIndex}`} className={nameDoubt || priceDoubt ? "review-item review-item--doubt" : "review-item"} data-testid="review-item">
                      <div className="review-item__head">
                        <div className={nameDoubt ? "review-field review-field--doubt" : "review-field"}>
                          <TextInput label="Позиция" maxLength={250} value={item.name} hint={nameDoubt ? "Проверьте название" : undefined} error={item.name.trim() ? undefined : "Назовите позицию"} onChange={(event) => updateItem(sectionIndex, itemIndex, { name: event.target.value, field_confidence: { name: 1, price: item.field_confidence?.price ?? null }, source_confidence: priceDoubt ? item.source_confidence : 1 })} />
                        </div>
                        <IconButton aria-label={`Убрать ${item.name}`} icon={<Trash2 size={20} />} onClick={() => removeItem(sectionIndex, itemIndex)} />
                      </div>
                      {sized ? (
                        <div className="review-sizes">
                          {item.variants!.map((variant, variantIndex) => (
                            <ReviewPrice
                              key={`${variant.name}-${variantIndex}`}
                              label={`${variant.name}, ₽`}
                              minor={variant.price_minor}
                              missing={!variant.price_minor}
                              doubt={!variant.price_minor}
                              emptyHint={item.variants!.some((entry) => entry.price_minor > 0) ? "Размер без цены будет скрыт" : "Без цены позицию не опубликовать"}
                              onChange={(minor) => {
                                const variants = item.variants!.map((entry, at) => (at === variantIndex ? { ...entry, price_minor: minor } : entry));
                                updateItem(sectionIndex, itemIndex, { variants, price_missing: variants.some((entry) => !entry.price_minor), field_confidence: { name: item.field_confidence?.name ?? null, price: 1 } });
                              }}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="review-item__row">
                          <ReviewPrice
                            label="Цена, ₽"
                            minor={item.price_minor}
                            missing={Boolean(item.price_missing)}
                            doubt={priceDoubt}
                            emptyHint="Без цены позицию не опубликовать"
                            onChange={(minor, missing) => updateItem(sectionIndex, itemIndex, { price_minor: minor, price_missing: missing, field_confidence: { name: item.field_confidence?.name ?? null, price: missing ? 0 : 1 }, source_confidence: nameDoubt ? item.source_confidence : missing ? 0 : 1 })}
                          />
                          <TextInput label="Вес / объём" maxLength={100} placeholder="250 мл" value={item.weight_text ?? ""} onChange={(event) => updateItem(sectionIndex, itemIndex, { weight_text: event.target.value || null })} />
                        </div>
                      )}
                      {item.description !== null && item.description !== "" && (
                        <div className="review-item__desc-row">
                          <TextInput label="Описание" maxLength={500} value={item.description} onChange={(event) => updateItem(sectionIndex, itemIndex, { description: event.target.value || null, description_source: event.target.value ? item.description_source ?? null : null })} />
                          {item.description_source === "ai" && <span className="review-badge review-badge--ai" title="Описание предложил ИИ — проверьте"><Sparkles size={14} aria-hidden="true" />ИИ</span>}
                          <IconButton aria-label={`Убрать описание ${item.name}`} icon={<X size={20} />} onClick={() => updateItem(sectionIndex, itemIndex, { description: null, description_source: null })} />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              <Button variant="ghost" icon={<Plus size={20} />} onClick={() => updateSection(sectionIndex, { items: [...section.items, emptyItem()] })}>Позиция</Button>
            </section>
          ))}
          <Button variant="ghost" icon={<ListPlus size={20} />} onClick={() => setSections((current) => [...current, { name: "Новый раздел", items: [emptyItem()] }])}>Раздел</Button>
        </div>
      )}
    </Sheet>
  );
}
