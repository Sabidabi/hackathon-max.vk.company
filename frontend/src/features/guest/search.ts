// Client-side menu search with typos (P1-DOC-6 «Поиск с опечатками», P1-TASK-19).
// Pure functions over the published snapshot: no imports, so `tests/guest-search.unit.mjs`
// bundles this file alone.

/** The parts of a menu position the search reads. */
export interface SearchableItem {
  id: string;
  name: string;
  description?: string | null;
  ingredients?: string | null;
  allergens?: string[];
  tags?: string[];
  configuration?: {
    variants?: { name: string }[];
    modifier_groups?: { name: string; options: { name: string }[] }[];
  } | null;
}

export interface SearchHit<T> {
  item: T;
  score: number;
  /** [start, end) ranges in `item.name` to highlight. */
  highlights: Array<[number, number]>;
}

/** Lower case, ё → е, letters and digits only, single spaces. */
export function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(" ") : [];
}

/**
 * Restricted Damerau–Levenshtein distance (optimal string alignment) with an early exit:
 * returns `limit + 1` as soon as the distance is known to exceed `limit`.
 */
export function damerauLevenshtein(a: string, b: string, limit = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous2: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, previous2[j - 2] + 1);
      }
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    previous2 = previous;
    previous = current;
  }
  return previous[b.length];
}

/** Query words shorter than this must match exactly (as a word prefix). */
export const TYPO_MIN_LENGTH = 4;

/**
 * How well one query word matches one text word: 3 — exact word, 2 — prefix (partial input),
 * 1 — one typo (whole word or the prefix of the same length), 0 — no match.
 */
export function wordMatch(query: string, word: string): number {
  if (!query || !word) return 0;
  if (word === query) return 3;
  if (word.startsWith(query)) return 2;
  if (query.length < TYPO_MIN_LENGTH) return 0;
  if (damerauLevenshtein(query, word, 1) <= 1) return 1;
  // Partial input with a typo: «капучт» against the start of «капучино».
  for (const length of [query.length, query.length - 1, query.length + 1]) {
    if (length < TYPO_MIN_LENGTH - 1 || length >= word.length) continue;
    if (damerauLevenshtein(query, word.slice(0, length), 1) <= 1) return 1;
  }
  return 0;
}

interface Field {
  words: string[];
  weight: number;
}

function itemFields(item: SearchableItem): Field[] {
  const config = item.configuration;
  const options = [
    ...(config?.variants ?? []).map((variant) => variant.name),
    ...(config?.modifier_groups ?? []).flatMap((group) => [group.name, ...group.options.map((option) => option.name)]),
  ];
  return [
    { words: tokenize(item.name), weight: 4 },
    { words: tokenize([...(item.tags ?? []), ...(item.allergens ?? [])].join(" ")), weight: 2 },
    { words: tokenize(options.join(" ")), weight: 2 },
    { words: tokenize(`${item.description ?? ""} ${item.ingredients ?? ""}`), weight: 1 },
  ];
}

/** Highlight ranges in the original name for query words that match its words. */
export function highlightRanges(name: string, queryWords: string[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const pattern = /[\p{L}\p{N}]+/gu;
  for (const match of name.matchAll(pattern)) {
    const word = normalizeText(match[0]);
    const start = match.index ?? 0;
    let best = 0;
    for (const query of queryWords) {
      const quality = wordMatch(query, word);
      if (quality === 2) best = Math.max(best, Math.min(query.length, match[0].length));
      else if (quality) best = match[0].length;
    }
    if (best) ranges.push([start, start + best]);
  }
  return ranges;
}

/**
 * Every query word must match some word of the item (name, tags, sizes and add-ons,
 * description). Results are sorted by score, then by the menu order.
 */
export function searchItems<T extends SearchableItem>(items: readonly T[], query: string): SearchHit<T>[] {
  const queryWords = tokenize(query);
  if (!queryWords.length) return [];
  const hits: Array<SearchHit<T> & { order: number }> = [];
  items.forEach((item, order) => {
    const fields = itemFields(item);
    let score = 0;
    for (const queryWord of queryWords) {
      let best = 0;
      for (const field of fields) {
        for (const word of field.words) {
          const quality = wordMatch(queryWord, word);
          if (quality) best = Math.max(best, quality * field.weight);
        }
      }
      if (!best) return;
      score += best;
    }
    hits.push({ item, score, highlights: highlightRanges(item.name, queryWords), order });
  });
  return hits
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .map(({ order: _order, ...hit }) => hit);
}
