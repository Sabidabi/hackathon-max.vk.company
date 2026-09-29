import { useQueries } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { deviceStorage } from "../../max";
import { GuestApiError, quoteGuestItem, type GuestMenuTab } from "./api";
import {
  addLine,
  choiceStorageKey,
  clampQty,
  parseStoredChoice,
  resolveLine,
  serializeChoice,
  type ChoiceLine,
} from "./choice";

export type LineState =
  | { kind: "pending" }
  | { kind: "ok"; unitPriceMinor: number; totalPriceMinor: number; priceUpdated: boolean }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; message: string };

export interface ChoiceView {
  line: ChoiceLine;
  state: LineState;
}

export interface ChoiceTotals {
  /** Sum of qty over all lines (the bar shows «N позиций»). */
  count: number;
  /** Sum of server quotes of available lines; null while any of them is still pending. */
  totalMinor: number | null;
  availableCount: number;
  hasErrors: boolean;
  hasPriceUpdates: boolean;
}

/**
 * «Мой выбор» of one point: lines in device storage, each re-quoted by the server against
 * the current published snapshot. `priceUpdated` stays on until the guest has seen the list
 * (`acknowledge`), then the new prices become the remembered ones.
 */
export function useChoice(publicId: string, tabs: GuestMenuTab[] | null) {
  const [lines, setLines] = useState<ChoiceLine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const key = choiceStorageKey(publicId);
  const skipSave = useRef(true);

  useEffect(() => {
    let active = true;
    skipSave.current = true;
    setLoaded(false);
    void deviceStorage.getItem(key).then((raw) => {
      if (!active) return;
      setLines(parseStoredChoice(raw));
      setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [key]);

  useEffect(() => {
    if (!loaded) return;
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    if (lines.length) void deviceStorage.setItem(key, serializeChoice(lines));
    else void deviceStorage.removeItem(key);
  }, [key, lines, loaded]);

  const resolved = useMemo(() => (tabs ? lines.map((line) => resolveLine(tabs, line)) : []), [lines, tabs]);

  const quotes = useQueries({
    queries: resolved.map((entry) => entry.status === "ok"
      ? {
        queryKey: ["guest-quote", publicId, entry.item.id, entry.variantId, entry.modifiers, entry.line.qty],
        queryFn: ({ signal }: { signal: AbortSignal }) => quoteGuestItem(publicId, {
          itemId: entry.item.id,
          variantId: entry.variantId,
          modifiers: entry.modifiers,
          quantity: entry.line.qty,
        }, signal),
        retry: false,
        staleTime: 30_000,
        // Keep the previous line total while a new quantity is quoted, so the bar does not blink.
        placeholderData: (previous: unknown) => previous,
      }
      : { queryKey: ["guest-quote-skip", entry.line.lineId], queryFn: () => null, enabled: false }),
  });

  const views: ChoiceView[] = useMemo(() => resolved.map((entry, index) => {
    if (entry.status === "unavailable") return { line: entry.line, state: { kind: "unavailable", reason: entry.reason } };
    const quote = quotes[index];
    if (quote?.isError) {
      const error = quote.error;
      if (error instanceof GuestApiError && (error.status === 409 || error.status === 404)) {
        return { line: entry.line, state: { kind: "unavailable", reason: "Нет в наличии" } };
      }
      if (error instanceof GuestApiError && error.status === 422) {
        return { line: entry.line, state: { kind: "unavailable", reason: "Выбор изменился — соберите позицию заново" } };
      }
      return { line: entry.line, state: { kind: "error", message: error.message } };
    }
    const data = quote?.data as { unit_price_minor: number; total_price_minor?: number } | null | undefined;
    if (!data) return { line: entry.line, state: { kind: "pending" } };
    // The line total is the server's (money invariant): no client unit × qty fallback.
    if (typeof data.total_price_minor !== "number") {
      return { line: entry.line, state: { kind: "error", message: "Сервер не вернул сумму позиции" } };
    }
    return {
      line: entry.line,
      state: {
        kind: "ok",
        unitPriceMinor: data.unit_price_minor,
        totalPriceMinor: data.total_price_minor,
        priceUpdated: entry.line.unitPriceMinor !== null && entry.line.unitPriceMinor !== data.unit_price_minor,
      },
    };
  }), [quotes, resolved]);

  const totals: ChoiceTotals = useMemo(() => {
    let total = 0;
    let pending = false;
    let availableCount = 0;
    for (const view of views) {
      if (view.state.kind === "ok") {
        // Temporary client-side sum of server line totals until the batch quote.
        total += view.state.totalPriceMinor;
        availableCount += view.line.qty;
      } else if (view.state.kind === "pending") pending = true;
    }
    return {
      count: lines.reduce((sum, line) => sum + line.qty, 0),
      totalMinor: pending ? null : total,
      availableCount,
      hasErrors: views.some((view) => view.state.kind === "error"),
      hasPriceUpdates: views.some((view) => view.state.kind === "ok" && view.state.priceUpdated),
    };
  }, [lines, views]);

  const add = useCallback((line: ChoiceLine) => setLines((current) => addLine(current, line)), []);
  const setQty = useCallback((lineId: string, qty: number) => setLines((current) => current.map((line) => line.lineId === lineId ? { ...line, qty: clampQty(qty) } : line)), []);
  const remove = useCallback((lineId: string) => setLines((current) => current.filter((line) => line.lineId !== lineId)), []);
  const retry = useCallback(() => quotes.forEach((quote) => { if (quote.isError) void quote.refetch(); }), [quotes]);

  /** The guest has seen the new prices: remember them and the current ids. */
  const acknowledge = useCallback(() => {
    const updates = new Map<string, Partial<ChoiceLine>>();
    resolved.forEach((entry, index) => {
      const view = views[index];
      if (entry.status !== "ok" || view?.state.kind !== "ok") return;
      updates.set(entry.line.lineId, {
        itemId: entry.item.id,
        itemKey: entry.item.item_key ?? entry.line.itemKey,
        variantId: entry.variantId,
        options: entry.line.options.map((option, optionIndex) => ({ ...option, id: entry.modifiers[optionIndex]?.option_id ?? option.id })),
        unitPriceMinor: view.state.unitPriceMinor,
      });
    });
    if (!updates.size) return;
    setLines((current) => {
      let changed = false;
      const next = current.map((line) => {
        const update = updates.get(line.lineId);
        if (!update) return line;
        const merged = { ...line, ...update };
        if (JSON.stringify(merged) !== JSON.stringify(line)) changed = true;
        return merged;
      });
      return changed ? next : current;
    });
  }, [resolved, views]);

  return { lines, loaded, views, totals, add, setQty, remove, retry, acknowledge };
}
