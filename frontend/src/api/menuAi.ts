import { errorDetail } from "./errors";
import type { DraftMenu } from "./menu";

export interface ProposedVariant {
  name: string;
  price_minor: number;
  weight_text: string | null;
  is_available: boolean;
  is_default: boolean;
}

export interface ProposedModifierOption {
  name: string;
  price_minor: number;
  min_quantity: number;
  max_quantity: number;
  default_quantity: number;
  is_available: boolean;
}

export interface ProposedModifierGroup {
  name: string;
  min_quantity: number;
  max_quantity: number;
  options: ProposedModifierOption[];
}

export interface MenuAiPlan {
  summary: string;
  warnings: string[];
  operations: Array<{
    type: "create_item";
    section_name: string;
    create_section_if_missing: boolean;
    item: {
      name: string;
      description: string | null;
      base_price_minor: number;
      weight_text: string | null;
      variants: ProposedVariant[];
      modifier_groups: ProposedModifierGroup[];
    };
  }>;
}

export interface MenuAiProposal {
  proposal_id: string;
  plan: MenuAiPlan;
  expires_at: string;
}

async function parseJson<T>(response: Response, fallback: string): Promise<T> {
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new Error(errorDetail(payload) ?? fallback);
  }
  return response.json() as Promise<T>;
}

export async function fetchMenuAiStatus(restaurantId: string) {
  return parseJson<{ provider: "openai"; configured: boolean; capabilities: string[] }>(
    await fetch(`/api/v1/restaurants/${restaurantId}/menu/ai/status`, {
      credentials: "include",
    }),
    "Не удалось проверить ИИ-помощника",
  );
}

export async function planMenuChange(
  restaurantId: string,
  prompt: string,
  expectedRevision: string,
) {
  return parseJson<MenuAiProposal>(
    await fetch(`/api/v1/restaurants/${restaurantId}/menu/ai/plan`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, expected_revision: expectedRevision }),
    }),
    "Не удалось подготовить изменения",
  );
}

export async function applyMenuChange(
  restaurantId: string,
  proposalId: string,
  expectedRevision: string,
) {
  return parseJson<DraftMenu>(
    await fetch(`/api/v1/restaurants/${restaurantId}/menu/ai/apply`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposal_id: proposalId, expected_revision: expectedRevision }),
    }),
    "Не удалось применить изменения",
  );
}
