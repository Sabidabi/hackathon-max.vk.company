// AI features of the cabinet (P1-DOC-8): status, item description, «Синица проверила меню».
// AI only suggests: the description goes into the item form and reaches the draft through the
// usual autosave (revision check); the check lists findings computed by the server code.
import { parseApiJson } from "./errors";

export type AiProvider = "openai" | "mock";

export interface AiStatus {
  available: boolean;
  /** "mock" — the labelled demo adapter: the UI marks its results «Демо-ИИ». */
  provider: AiProvider | null;
}

export const aiKeys = { status: ["ai-status"] as const, check: (menuId: string) => ["menu-check", menuId] as const };

const json = (body: unknown): RequestInit => ({
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function fetchAiStatus(): Promise<AiStatus> {
  return parseApiJson<AiStatus>(await fetch("/api/v1/ai/status", { credentials: "include" }), "Не удалось проверить ИИ");
}

export interface DescribeSource {
  name: string;
  section?: string | null;
  ingredients?: string | null;
  weight_text?: string | null;
  sizes?: string[];
  modifiers?: string[];
}

export interface DescribeResult {
  description: string;
  provider: AiProvider;
  revision: string;
}

/** 409 — the draft changed elsewhere; 503 — the AI is unavailable; 429 — daily limit. */
export async function describeItem(menuId: string, expectedRevision: string, item: DescribeSource): Promise<DescribeResult> {
  return parseApiJson<DescribeResult>(
    await fetch(`/api/v1/menus/${menuId}/ai/description`, json({ expected_revision: expectedRevision, item })),
    "Не удалось написать описание",
  );
}

export type FindingCode = "no_price" | "price_outlier" | "duplicate_name" | "empty_section" | "no_description" | "no_photo";

export interface MenuFinding {
  code: FindingCode;
  severity: "warning" | "info";
  message: string;
  item_key: string | null;
  item_name: string | null;
  section: string | null;
  /** Short wording from the AI for this finding; the finding itself is from code. */
  tip: string | null;
}

export interface MenuCheck {
  revision: string;
  findings: MenuFinding[];
  summary: string | null;
  ai: "ok" | "unavailable" | "limit" | "skipped";
  provider: AiProvider | null;
}

export async function checkMenu(menuId: string): Promise<MenuCheck> {
  return parseApiJson<MenuCheck>(await fetch(`/api/v1/menus/${menuId}/check`, json({})), "Не удалось проверить меню");
}
