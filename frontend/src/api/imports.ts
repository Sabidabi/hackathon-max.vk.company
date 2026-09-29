import { errorDetail } from "./errors";
export interface ImportJob {
  id: string;
  restaurant_id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  status:
    | "uploaded"
    | "queued"
    | "extracting"
    | "ocr"
    | "structuring"
    | "needs_review"
    | "completed"
    | "failed";
  progress: number;
  page_count: number | null;
  item_count: number | null;
  error_message: string | null;
  error_code: string | null;
  extraction_method: string | null;
  ocr_confidence: number | null;
  /** "llm-v1" — structured by the AI and checked by the server; "heuristic-v1" — parser. */
  parser?: string | null;
  created_at: string;
}

export interface ReviewItem {
  name: string;
  price_minor: number;
  currency: string;
  weight_text: string | null;
  description: string | null;
  /** "document" — text from the menu; "ai" — a draft suggested by the AI, to be checked. */
  description_source?: "document" | "ai" | null;
  source_line: string | null;
  source_confidence: number | null;
  /** The price was not readable: the field is empty and marked «Проверьте цену». */
  price_missing?: boolean;
  field_confidence?: { name: number | null; price: number | null } | null;
  /** Sizes with their own prices (0 — not recognised). */
  variants?: { name: string; price_minor: number }[];
}

export interface ReviewSection {
  name: string;
  items: ReviewItem[];
}

export interface ImportReview {
  draft_revision: string;
  import_id: string;
  status: string;
  sections: ReviewSection[];
  unparsed_lines: string[];
  parser?: string;
  provider?: string | null;
  /** Why the AI did not structure the import (unavailable, limit, too_long, disabled, empty, no_items). */
  ai_fallback?: string | null;
}

export interface ApplyReviewResult {
  import_id: string;
  draft_version_id: string;
  section_count: number;
  item_count: number;
  status: string;
}

async function parseResponse(response: Response): Promise<ImportJob> {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(payload?.detail ?? `Загрузка завершилась с кодом ${response.status}`);
  }
  return response.json() as Promise<ImportJob>;
}

export async function listImports(restaurantId: string): Promise<ImportJob[]> {
  const response = await fetch(`/api/v1/restaurants/${restaurantId}/imports`, {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`Не удалось получить историю загрузок: ${response.status}`);
  }
  return response.json() as Promise<ImportJob[]>;
}

export async function uploadMenuSource(restaurantId: string, file: File): Promise<ImportJob> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`/api/v1/restaurants/${restaurantId}/imports`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  return parseResponse(response);
}

export async function retryImport(restaurantId: string, importId: string): Promise<ImportJob> {
  const response = await fetch(
    `/api/v1/restaurants/${restaurantId}/imports/${importId}/retry`,
    { method: "POST", credentials: "include" },
  );
  return parseResponse(response);
}

export async function fetchImportReview(
  restaurantId: string,
  importId: string,
): Promise<ImportReview> {
  const response = await fetch(
    `/api/v1/restaurants/${restaurantId}/imports/${importId}/review`,
    { credentials: "include" },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(payload?.detail ?? `Не удалось открыть результат: ${response.status}`);
  }
  return response.json() as Promise<ImportReview>;
}

export async function applyImportReview(
  restaurantId: string,
  importId: string,
  sections: ReviewSection[],
  expectedRevision: string,
): Promise<ApplyReviewResult> {
  const response = await fetch(
    `/api/v1/restaurants/${restaurantId}/imports/${importId}/apply`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sections, expected_revision: expectedRevision }),
    },
  );
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(errorDetail(payload) ?? `Не удалось сохранить черновик: ${response.status}`);
  }
  return response.json() as Promise<ApplyReviewResult>;
}
