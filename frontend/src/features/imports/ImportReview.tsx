import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  applyImportReview,
  fetchImportReview,
  type ImportJob,
  type ReviewItem,
  type ReviewSection,
} from "../../api/imports";

const emptyItem: ReviewItem = {
  name: "Новое блюдо",
  price_minor: 0,
  currency: "RUB",
  weight_text: null,
  description: null,
  source_line: null,
  source_confidence: null,
};

interface ImportReviewProps {
  restaurantId: string;
  importId: string;
  onClose: () => void;
}

export function ImportReview({ restaurantId, importId, onClose }: ImportReviewProps) {
  const queryClient = useQueryClient();
  const [sections, setSections] = useState<ReviewSection[]>([]);
  const review = useQuery({
    queryKey: ["import-review", restaurantId, importId],
    queryFn: () => fetchImportReview(restaurantId, importId),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    if (review.data) {
      setSections(structuredClone(review.data.sections));
    }
  }, [review.data]);

  const applyReview = useMutation({
    mutationFn: () => applyImportReview(restaurantId, importId, sections, review.data!.draft_revision),
    onSuccess: (result) => {
      queryClient.setQueryData<ImportJob[]>(["imports", restaurantId], (jobs = []) =>
        jobs.map((job) =>
          job.id === importId
            ? { ...job, status: "completed", progress: 100, item_count: result.item_count }
            : job,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: ["draft-menu", restaurantId] });
    },
  });

  function updateSection(sectionIndex: number, patch: Partial<ReviewSection>) {
    setSections((current) =>
      current.map((section, index) => (index === sectionIndex ? { ...section, ...patch } : section)),
    );
  }

  function updateItem(sectionIndex: number, itemIndex: number, patch: Partial<ReviewItem>) {
    setSections((current) =>
      current.map((section, currentSectionIndex) =>
        currentSectionIndex === sectionIndex
          ? {
              ...section,
              items: section.items.map((item, currentItemIndex) =>
                currentItemIndex === itemIndex ? { ...item, ...patch } : item,
              ),
            }
          : section,
      ),
    );
  }

  function removeItem(sectionIndex: number, itemIndex: number) {
    setSections((current) =>
      current
        .map((section, currentSectionIndex) =>
          currentSectionIndex === sectionIndex
            ? { ...section, items: section.items.filter((_, index) => index !== itemIndex) }
            : section,
        )
        .filter((section) => section.items.length > 0),
    );
  }

  if (review.isPending) {
    return <div className="review-panel">Загружаем распознанное меню…</div>;
  }
  if (review.isError) {
    return (
      <div className="review-panel">
        <p className="form-error">{review.error.message}</p>
        <button type="button" className="button-quiet" onClick={onClose}>
          Закрыть
        </button>
      </div>
    );
  }

  const itemCount = sections.reduce((total, section) => total + section.items.length, 0);
  const invalid =
    sections.length === 0 ||
    sections.some(
      (section) =>
        !section.name.trim() || section.items.some((item) => !item.name.trim() || item.price_minor < 0),
    );

  return (
    <div className="review-panel">
      <div className="review-heading">
        <div>
          <span className="section-kicker">Проверка распознавания</span>
          <h3>{itemCount} позиций</h3>
        </div>
        <button type="button" className="button-quiet" onClick={onClose}>
          Закрыть
        </button>
      </div>

      <p className="muted">
        Исправьте названия и цены. Подтверждение заменит содержимое текущего черновика, но не
        опубликует его.
      </p>

      {review.data.unparsed_lines.length > 0 && (
        <details className="review-warning">
          <summary>Не удалось распределить строк: {review.data.unparsed_lines.length}</summary>
          <ul>
            {review.data.unparsed_lines.slice(0, 20).map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="review-sections">
        {sections.map((section, sectionIndex) => (
          <details className="review-section" key={`section-${sectionIndex}`} open={sectionIndex < 2}>
            <summary>
              <span>{section.name || "Без названия"}</span>
              <small>{section.items.length} поз.</small>
            </summary>
            <div className="review-section-body">
              <label>
                <span>Название раздела</span>
                <input
                  value={section.name}
                  maxLength={200}
                  onChange={(event) => updateSection(sectionIndex, { name: event.target.value })}
                />
              </label>

              {section.items.map((item, itemIndex) => (
                <div className="review-item" key={`item-${sectionIndex}-${itemIndex}`}>
                  <label className="review-item-name">
                    <span>Позиция</span>
                    <input
                      value={item.name}
                      maxLength={250}
                      onChange={(event) =>
                        updateItem(sectionIndex, itemIndex, { name: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>Цена, ₽</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={item.price_minor / 100}
                      onChange={(event) =>
                        updateItem(sectionIndex, itemIndex, {
                          price_minor: Math.round(Number(event.target.value) * 100),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>Вес</span>
                    <input
                      value={item.weight_text ?? ""}
                      maxLength={100}
                      placeholder="250 г"
                      onChange={(event) =>
                        updateItem(sectionIndex, itemIndex, {
                          weight_text: event.target.value || null,
                        })
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="remove-item"
                    aria-label={`Удалить ${item.name}`}
                    onClick={() => removeItem(sectionIndex, itemIndex)}
                  >
                    ×
                  </button>
                </div>
              ))}

              <button
                type="button"
                className="button-quiet"
                onClick={() =>
                  updateSection(sectionIndex, { items: [...section.items, { ...emptyItem }] })
                }
              >
                + Добавить позицию
              </button>
            </div>
          </details>
        ))}
      </div>

      <button
        type="button"
        className="button-quiet add-section"
        onClick={() =>
          setSections((current) => [
            ...current,
            { name: "Новый раздел", items: [{ ...emptyItem }] },
          ])
        }
      >
        + Добавить раздел
      </button>

      {applyReview.isError && <p className="form-error">{applyReview.error.message}</p>}
      {applyReview.isSuccess ? (
        <div className="review-success">
          Меню сохранено в черновик: {applyReview.data.section_count} разделов и{" "}
          {applyReview.data.item_count} позиций.
        </div>
      ) : (
        <button
          type="button"
          className="apply-review"
          disabled={invalid || applyReview.isPending}
          onClick={() => { if (window.confirm("Импорт заменит весь текущий черновик меню. Опубликованное меню не изменится. Продолжить?")) applyReview.mutate(); }}
        >
          {applyReview.isPending ? "Сохраняем…" : "Подтвердить и сохранить в черновик"}
        </button>
      )}
    </div>
  );
}
