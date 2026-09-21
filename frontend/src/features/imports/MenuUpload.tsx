import { Help } from "../../components/Help";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import {
  listImports,
  retryImport,
  type ImportJob,
  uploadMenuSource,
} from "../../api/imports";
import { ImportReview } from "./ImportReview";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

const statusLabels: Record<ImportJob["status"], string> = {
  uploaded: "Загружено",
  queued: "В очереди",
  extracting: "Читаем PDF",
  ocr: "Распознаём текст",
  structuring: "Собираем меню",
  needs_review: "Нужна проверка",
  completed: "Готово",
  failed: "Ошибка",
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.ceil(bytes / 1024)} КБ`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function MenuUpload({ restaurantId }: { restaurantId: string }) {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [reviewImportId, setReviewImportId] = useState<string | null>(null);
  const imports = useQuery({
    queryKey: ["imports", restaurantId],
    queryFn: () => listImports(restaurantId),
    retry: false,
    refetchInterval: (query) => {
      const jobs = query.state.data;
      return jobs?.some((job) =>
        ["uploaded", "queued", "extracting", "ocr", "structuring"].includes(job.status),
      )
        ? 2_000
        : false;
    },
  });
  const upload = useMutation({
    mutationFn: async () => {
      if (!selectedFile) {
        throw new Error("Сначала выберите файл");
      }
      return uploadMenuSource(restaurantId, selectedFile);
    },
    onSuccess: (job) => {
      queryClient.setQueryData<ImportJob[]>(["imports", restaurantId], (current = []) => [
        job,
        ...current,
      ]);
      setSelectedFile(null);
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    },
  });
  const retry = useMutation({
    mutationFn: (importId: string) => retryImport(restaurantId, importId),
    onSuccess: (updated) => {
      queryClient.setQueryData<ImportJob[]>(["imports", restaurantId], (current = []) =>
        current.map((job) => (job.id === updated.id ? updated : job)),
      );
    },
  });

  function chooseFile(file: File | undefined) {
    upload.reset();
    setSelectionError(null);
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setSelectedFile(null);
      setSelectionError("Файл должен быть не больше 20 МБ");
      return;
    }
    setSelectedFile(file);
  }

  return (
    <div className="upload-section">
      <div>
        <h3>Импорт меню</h3>
        <Help label="Об импорте">PDF до 30 страниц, JPG или PNG до 20 МБ. После распознавания проверьте результат. Импорт заменяет черновик, но не публикует меню.</Help>
      </div>

      <label className="file-picker">
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
          onChange={(event) => chooseFile(event.target.files?.[0])}
        />
        <span>{selectedFile ? selectedFile.name : "Выбрать PDF или изображение"}</span>
        <small>{selectedFile ? formatFileSize(selectedFile.size) : "PDF · JPG · PNG"}</small>
      </label>

      {(selectionError || upload.isError || retry.isError) && (
        <p className="form-error" role="alert">
          {selectionError ?? upload.error?.message ?? retry.error?.message}
        </p>
      )}
      {upload.isSuccess && (
        <p className="form-success">Файл обрабатывается.</p>
      )}

      <button
        className="upload-button"
        type="button"
        disabled={!selectedFile || upload.isPending}
        onClick={() => upload.mutate()}
      >
        {upload.isPending ? "Загружаем…" : "Загрузить меню"}
      </button>

      {imports.isError && <p className="form-error">{imports.error.message}</p>}
      {imports.data && imports.data.length > 0 && (
        <div className="import-history">
          <strong>Последние загрузки</strong>
          {imports.data.slice(0, 3).map((job) => (
            <div className="import-row" key={job.id}>
              <div>
                <span>{job.original_name}</span>
                <small>
                  {formatFileSize(job.size_bytes)}
                  {job.page_count ? ` · ${job.page_count} стр.` : ""}
                  {job.item_count !== null ? ` · найдено позиций: ${job.item_count}` : ""}
                  {job.extraction_method === "ocr" && job.ocr_confidence !== null
                    ? ` · OCR ${Math.round(job.ocr_confidence * 100)}%`
                    : ""}
                </small>
                {job.error_message && <small className="import-note">{job.error_message}</small>}
              </div>
              <div className="import-row-actions">
                <span className={`import-status import-status--${job.status}`}>
                  {statusLabels[job.status]}
                  {job.progress > 0 && job.progress < 100 ? ` · ${job.progress}%` : ""}
                </span>
                {(job.status === "needs_review" || job.status === "completed") &&
                  job.item_count !== null &&
                  job.item_count > 0 && (
                    <button
                      type="button"
                      className="review-button"
                      onClick={() => setReviewImportId(job.id)}
                    >
                      {job.status === "completed" ? "Открыть" : "Проверить"}
                    </button>
                  )}
                {(job.status === "failed" || job.error_code === "ocr_required") && (
                  <button
                    type="button"
                    className="review-button"
                    disabled={retry.isPending}
                    onClick={() => retry.mutate(job.id)}
                  >
                    Повторить
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {reviewImportId && (
        <ImportReview
          restaurantId={restaurantId}
          importId={reviewImportId}
          onClose={() => setReviewImportId(null)}
        />
      )}
    </div>
  );
}
