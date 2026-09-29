// AI design assistant (POST site/ai/plan|apply): the model only proposes a typed patch of
// visual settings; a person applies it to the draft. Publication stays in the cabinet.
import { parseApiJson } from "./errors";
import type { SiteDraft } from "./site";

export interface DesignProposal {
  proposal_id: string;
  summary: string;
  changes: Record<string, string | number | boolean>;
  warnings: string[];
  /** "mock" — the labelled demo adapter: the UI marks it «Демо-ИИ». */
  provider: string;
  expires_at: string;
}

const json = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal,
});

export async function planDesign(restaurantId: string, prompt: string, expectedRevision: string, signal?: AbortSignal): Promise<DesignProposal> {
  return parseApiJson<DesignProposal>(
    await fetch(`/api/v1/restaurants/${restaurantId}/site/ai/plan`, json({ prompt, expected_revision: expectedRevision }, signal)),
    "Не удалось подготовить оформление",
  );
}

export async function applyDesign(restaurantId: string, proposalId: string, expectedRevision: string, signal?: AbortSignal): Promise<SiteDraft> {
  return parseApiJson<SiteDraft>(
    await fetch(`/api/v1/restaurants/${restaurantId}/site/ai/apply`, json({ proposal_id: proposalId, expected_revision: expectedRevision }, signal)),
    "Не удалось применить оформление",
  );
}

const LABELS: Record<string, string> = {
  template: "Тема",
  theme_mode: "Режим",
  primary_color: "Акцент",
  background_color: "Фон",
  surface_color: "Карточки",
  text_color: "Текст",
  icon_color: "Иконки",
  font_scale: "Размер шрифта",
  menu_layout: "Раскладка",
  card_style: "Карточка",
  card_radius: "Скругление",
  image_ratio: "Фото",
  add_button: "Кнопка добавления",
  heading_font: "Шрифт заголовков",
  body_font: "Шрифт текста",
  show_description: "Описание",
  show_weight: "Вес и объём",
};

const VALUES: Record<string, Record<string, string>> = {
  template: { modern: "Минимал", classic: "Бистро", cafe: "Поп", noir: "Ночь" },
  theme_mode: { light: "светлый", dark: "тёмный" },
  menu_layout: { grid: "сетка", list: "список", large: "крупные" },
  card_style: { soft: "мягкая", outline: "контур", flat: "заливка" },
  card_radius: { sharp: "острые углы", soft: "мягкие", round: "круглые" },
  image_ratio: { square: "квадрат", landscape: "широкое", portrait: "высокое" },
  add_button: { round: "кружок «+»", pill: "с подписью" },
  heading_font: { sans: "строгий", humanist: "мягкий", rounded: "округлый", serif: "с засечками", elegant: "изящный", mono: "печатный" },
  body_font: { sans: "строгий", humanist: "мягкий", serif: "с засечками" },
};

/** «Раскладка: список» for one change of a proposal. */
export function describeChange(key: string, value: string | number | boolean): { label: string; text: string; color: string | null } {
  const label = LABELS[key] ?? key;
  if (typeof value === "boolean") return { label, text: value ? "показывать" : "скрыть", color: null };
  if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) return { label, text: value.toUpperCase(), color: value };
  return { label, text: VALUES[key]?.[String(value)] ?? String(value), color: null };
}
