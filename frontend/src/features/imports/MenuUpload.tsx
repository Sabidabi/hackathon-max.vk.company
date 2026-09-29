import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FileUp, RotateCcw, ScanText, Sparkles } from "lucide-react";
import { useRef, useState } from "react";

import { trackAdmin } from "../../analytics";
import { listImports, retryImport, uploadMenuSource, type ImportJob } from "../../api/imports";
import { Button, EmptyState, Skeleton } from "../../design";
import { showToast } from "../../design/toast";
import { haptics } from "../../max";
import { ImportReview } from "./ImportReview";
import "./imports.css";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ACTIVE: ImportJob["status"][] = ["uploaded", "queued", "extracting", "ocr", "structuring"];

const statusLabels: Record<ImportJob["status"], string> = {
  uploaded: "Загружено",
  queued: "В очереди",
  extracting: "Читаем PDF",
  ocr: "Распознаём текст",
  structuring: "Собираем меню",
  needs_review: "Нужна проверка",
  completed: "В черновике",
  failed: "Ошибка",
};

function formatFileSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} КБ` : `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function jobMeta(job: ImportJob): string {
  return [
    formatFileSize(job.size_bytes),
    job.page_count ? `${job.page_count} стр.` : null,
    job.item_count !== null ? `позиций: ${job.item_count}` : null,
    job.parser === "llm-v1" ? "разобрано ИИ" : job.parser ? "без ИИ" : null,
  ].filter(Boolean).join(" · ");
}

/**
 * «Импорт PDF или фото»: upload → OCR/text → structuring (AI when it
 * is available, otherwise the parser) → review sheet → «Применить в черновик». Nothing is
 * published automatically.
 */
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
    refetchInterval: (query) => (query.state.data?.some((job) => ACTIVE.includes(job.status)) ? 2_000 : false),
  });
  const upload = useMutation({
    mutationFn: async () => {
      if (!selectedFile) throw new Error("Сначала выберите файл");
      return uploadMenuSource(restaurantId, selectedFile);
    },
    onSuccess: (job) => {
      haptics.notify("success");
      trackAdmin("import_started");
      queryClient.setQueryData<ImportJob[]>(["imports", restaurantId], (current = []) => [job, ...current]);
      setSelectedFile(null);
      if (inputRef.current) inputRef.current.value = "";
      showToast("Файл загружен — распознаём меню");
    },
    onError: () => haptics.notify("error"),
  });
  const retry = useMutation({
    mutationFn: (importId: string) => retryImport(restaurantId, importId),
    onSuccess: (updated) => {
      queryClient.setQueryData<ImportJob[]>(["imports", restaurantId], (current = []) =>
        current.map((job) => (job.id === updated.id ? updated : job)));
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

  const error = selectionError ?? (upload.isError ? upload.error.message : null) ?? (retry.isError ? retry.error.message : null);
  return (
    <div className="import">
      <div className="import-intro">
        <span className="import-intro__icon" aria-hidden="true"><ScanText size={22} /></span>
        <p>Загрузите PDF или фото меню — мы распознаем разделы, позиции и цены. Вы проверите результат, и он попадёт в черновик. Гости ничего не увидят до публикации.</p>
      </div>

      <label className={["import-drop", selectedFile && "import-drop--chosen"].filter(Boolean).join(" ")}>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
          aria-label="Выбрать PDF или фото меню"
          onChange={(event) => chooseFile(event.target.files?.[0])}
        />
        <FileUp size={28} aria-hidden="true" />
        <span className="import-drop__text">
          <strong>{selectedFile ? selectedFile.name : "Выбрать PDF или фото"}</strong>
          <small>{selectedFile ? formatFileSize(selectedFile.size) : "PDF до 30 страниц · JPG · PNG · до 20 МБ"}</small>
        </span>
      </label>
      {error && <p className="cabinet-error" role="alert">{error}</p>}
      <Button icon={<Sparkles size={20} />} disabled={!selectedFile} loading={upload.isPending} onClick={() => upload.mutate()}>
        Распознать меню
      </Button>

      <section className="import-history" aria-labelledby="import-history-title">
        <h2 id="import-history-title">Загрузки</h2>
        {imports.isPending && <Skeleton height={64} radius="control" />}
        {imports.isError && (
          <EmptyState icon={<AlertTriangle size={24} />} tone="danger" title="Не удалось загрузить историю" action={<Button variant="secondary" onClick={() => void imports.refetch()}>Повторить</Button>}>
            {imports.error.message}
          </EmptyState>
        )}
        {imports.data && !imports.data.length && <p className="cabinet-muted">Здесь появятся загруженные файлы.</p>}
        {imports.data && imports.data.length > 0 && (
          <ul className="import-jobs">
            {imports.data.slice(0, 5).map((job) => {
              const active = ACTIVE.includes(job.status);
              const reviewable = (job.status === "needs_review" || job.status === "completed") && (job.item_count ?? 0) > 0;
              return (
                <li key={job.id} className="import-job">
                  <div className="import-job__text">
                    <strong>{job.original_name}</strong>
                    <small>{jobMeta(job)}</small>
                    {job.error_message && <small className="import-job__note">{job.error_message}</small>}
                    {active && (
                      <span className="import-progress" role="progressbar" aria-label={statusLabels[job.status]} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress}>
                        <span style={{ transform: `scaleX(${Math.max(0.05, job.progress / 100)})` }} />
                      </span>
                    )}
                  </div>
                  <div className="import-job__actions">
                    <span className={`import-status import-status--${job.status}`}>{statusLabels[job.status]}</span>
                    {reviewable && (
                      <Button variant={job.status === "completed" ? "ghost" : "secondary"} onClick={() => setReviewImportId(job.id)}>
                        {job.status === "completed" ? "Открыть" : "Проверить"}
                      </Button>
                    )}
                    {(job.status === "failed" || job.error_code === "ocr_required") && (
                      <Button variant="ghost" icon={<RotateCcw size={18} />} loading={retry.isPending && retry.variables === job.id} onClick={() => retry.mutate(job.id)}>
                        Повторить
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ImportReview
        restaurantId={restaurantId}
        importId={reviewImportId}
        onClose={() => setReviewImportId(null)}
      />
    </div>
  );
}
