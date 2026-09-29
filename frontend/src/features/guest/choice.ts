// «Мой выбор»: what the guest picked, kept on the
// device per point. Prices here are only the last server answers — the total shown to the
// guest is always a sum of fresh server quotes (`/menu/quote` per line). A batch server quote
// of the whole choice is backend task the spec.

import type { GuestItem, GuestMenuTab } from "./api";

export const CHOICE_QTY_MIN = 1;
export const CHOICE_QTY_MAX = 20;
export const CHOICE_MAX_LINES = 50;

export interface ChoiceOption {
  id: string;
  name: string;
  groupName: string;
  quantity: number;
}

export interface ChoiceLine {
  lineId: string;
  itemId: string;
  itemKey: string | null;
  sectionName: string;
  name: string;
  variantId: string | null;
  variantName: string | null;
  options: ChoiceOption[];
  qty: number;
  /** Last server price of one portion, kopecks; null until the first quote. */
  unitPriceMinor: number | null;
}

interface StoredChoice {
  v: 1;
  lines: ChoiceLine[];
}

export function choiceStorageKey(publicId: string): string {
  return `sinitsa.guest.choice.${publicId}`;
}

export function clampQty(value: number): number {
  if (!Number.isFinite(value)) return CHOICE_QTY_MIN;
  return Math.min(CHOICE_QTY_MAX, Math.max(CHOICE_QTY_MIN, Math.round(value)));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Parses stored JSON defensively: device storage is untrusted input. */
export function parseStoredChoice(raw: string | null): ChoiceLine[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<StoredChoice>;
    if (parsed?.v !== 1 || !Array.isArray(parsed.lines)) return [];
    return parsed.lines
      .filter((line): line is ChoiceLine => Boolean(line) && isString(line.lineId) && isString(line.itemId) && isString(line.name))
      .slice(0, CHOICE_MAX_LINES)
      .map((line) => ({
        lineId: line.lineId,
        itemId: line.itemId,
        itemKey: isString(line.itemKey) ? line.itemKey : null,
        sectionName: isString(line.sectionName) ? line.sectionName : "",
        name: line.name,
        variantId: isString(line.variantId) ? line.variantId : null,
        variantName: isString(line.variantName) ? line.variantName : null,
        options: Array.isArray(line.options)
          ? line.options
            .filter((option) => option && isString(option.id) && isString(option.name))
            .map((option) => ({
              id: option.id,
              name: option.name,
              groupName: isString(option.groupName) ? option.groupName : "",
              quantity: Math.max(1, Math.min(20, Math.round(Number(option.quantity) || 1))),
            }))
          : [],
        qty: clampQty(Number(line.qty)),
        unitPriceMinor: Number.isInteger(line.unitPriceMinor) ? line.unitPriceMinor : null,
      }));
  } catch {
    return [];
  }
}

export function serializeChoice(lines: ChoiceLine[]): string {
  return JSON.stringify({ v: 1, lines } satisfies StoredChoice);
}

/** Same position with the same size and add-ons → one line with a larger quantity. */
export function sameSelection(a: Pick<ChoiceLine, "itemId" | "variantId" | "options">, b: Pick<ChoiceLine, "itemId" | "variantId" | "options">): boolean {
  if (a.itemId !== b.itemId || a.variantId !== b.variantId || a.options.length !== b.options.length) return false;
  const key = (options: ChoiceOption[]) => options.map((option) => `${option.id}:${option.quantity}`).sort().join("|");
  return key(a.options) === key(b.options);
}

export function addLine(lines: ChoiceLine[], line: ChoiceLine): ChoiceLine[] {
  const existing = lines.find((candidate) => sameSelection(candidate, line));
  if (existing) {
    return lines.map((candidate) => candidate === existing
      ? { ...candidate, qty: clampQty(candidate.qty + line.qty), unitPriceMinor: line.unitPriceMinor ?? candidate.unitPriceMinor }
      : candidate);
  }
  return [...lines, line].slice(-CHOICE_MAX_LINES);
}

export type ResolvedLine =
  | { status: "ok"; line: ChoiceLine; item: GuestItem; variantId: string | null; modifiers: { option_id: string; quantity: number }[] }
  | { status: "unavailable"; line: ChoiceLine; reason: string };

function findItem(tabs: GuestMenuTab[], line: ChoiceLine): GuestItem | null {
  const all = tabs.flatMap((tab) => tab.sections.flatMap((section) => section.items.map((item) => ({ item, section: section.name }))));
  return all.find(({ item }) => item.id === line.itemId)?.item
    ?? (line.itemKey ? all.find(({ item }) => item.item_key === line.itemKey)?.item : undefined)
    ?? all.find(({ item, section }) => item.name === line.name && section === line.sectionName)?.item
    ?? null;
}

/**
 * Maps a stored line onto the current published snapshot. IDs change with every publication
 * on older servers, so the position is found by id, then by `item_key`, then by section and
 * name; its size and add-ons by id, then by name. Anything missing → «Нет в наличии».
 */
export function resolveLine(tabs: GuestMenuTab[], line: ChoiceLine): ResolvedLine {
  const item = findItem(tabs, line);
  if (!item || !item.is_available) return { status: "unavailable", line, reason: "Нет в наличии" };
  const config = item.configuration;
  let variantId: string | null = null;
  if (config?.variants.length) {
    const variant = config.variants.find((candidate) => candidate.id === line.variantId)
      ?? config.variants.find((candidate) => line.variantName !== null && candidate.name === line.variantName);
    if (!variant || !variant.is_available) return { status: "unavailable", line, reason: "Размера нет в наличии" };
    variantId = variant.id;
  }
  const modifiers: { option_id: string; quantity: number }[] = [];
  for (const chosen of line.options) {
    const groups = config?.modifier_groups ?? [];
    const option = groups.flatMap((group) => group.options).find((candidate) => candidate.id === chosen.id)
      ?? groups.find((group) => group.name === chosen.groupName)?.options.find((candidate) => candidate.name === chosen.name);
    if (!option || !option.is_available) return { status: "unavailable", line, reason: `Нет в наличии: ${chosen.name}` };
    modifiers.push({ option_id: option.id, quantity: chosen.quantity });
  }
  return { status: "ok", line, item, variantId, modifiers };
}

/** Short description of the chosen size and add-ons: «350 мл, Овсяное, Карамель ×2». */
export function lineDetails(line: Pick<ChoiceLine, "variantName" | "options">): string {
  return [
    line.variantName,
    ...line.options.map((option) => option.quantity > 1 ? `${option.name} ×${option.quantity}` : option.name),
  ].filter(Boolean).join(", ");
}

export function pluralPositions(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} позиция`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} позиции`;
  return `${count} позиций`;
}
