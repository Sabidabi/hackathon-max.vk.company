import { useQuery } from "@tanstack/react-query";
import { Heart, Minus, Pencil, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Link } from "react-router-dom";

import { Button, IconButton } from "../../design";
import { haptics } from "../../max";
import { GuestApiError, formatMoney, quoteGuestItem, type GuestItem, type ModifierGroup } from "./api";
import type { ChoiceLine } from "./choice";
import { heartBurst, slideIndicator, type Rect } from "./motion";
import { MotionSheet, type SheetOrigin } from "./MotionSheet";
import { RollingText } from "./RollingText";
import { NotifyWhenBackButton } from "../notifications/GuestButtons";

type Quantities = Record<string, number>;

function initialVariant(item: GuestItem): string | null {
  const variants = item.configuration?.variants ?? [];
  return variants.find((variant) => variant.id === item.configuration?.default_variant_id && variant.is_available)?.id
    ?? variants.find((variant) => variant.is_available)?.id
    ?? null;
}

function initialQuantities(item: GuestItem): Quantities {
  return Object.fromEntries((item.configuration?.modifier_groups ?? []).flatMap((group) =>
    group.options.map((option) => [option.id, option.is_available ? option.default_quantity : 0])));
}

function groupCount(group: ModifierGroup, quantities: Quantities): number {
  return group.options.reduce((sum, option) => sum + (quantities[option.id] ?? 0), 0);
}

/** A group is unmet when the chosen count or an option count breaks its limits. */
export function groupProblem(group: ModifierGroup, quantities: Quantities): boolean {
  const count = groupCount(group, quantities);
  return count < group.min_quantity
    || count > group.max_quantity
    || group.options.some((option) => (quantities[option.id] ?? 0) < option.min_quantity || (quantities[option.id] ?? 0) > option.max_quantity);
}

/** «Выберите молоко»: the required choice is explained next to the group. */
export function requiredHint(group: ModifierGroup): string {
  const name = group.name.trim();
  const lowered = name ? name[0].toLocaleLowerCase("ru") + name.slice(1) : "вариант";
  return group.min_quantity > 1 ? `Выберите ${lowered}: не меньше ${group.min_quantity}` : `Выберите ${lowered}`;
}

/** True when «+» on the card may add the item without opening it (nothing to choose). */
export function canQuickAdd(item: GuestItem): boolean {
  if (!item.is_available) return false;
  const config = item.configuration;
  if (config?.variants.length && !initialVariant(item)) return false;
  const groups = config?.modifier_groups ?? [];
  if (groups.some((group) => group.min_quantity > 0)) return false;
  const quantities = initialQuantities(item);
  return !groups.some((group) => groupProblem(group, quantities));
}

export function buildLine(item: GuestItem, sectionName: string, variantId: string | null, quantities: Quantities, unitPriceMinor: number | null): ChoiceLine {
  const config = item.configuration;
  const variant = config?.variants.find((candidate) => candidate.id === variantId) ?? null;
  return {
    lineId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    itemId: item.id,
    itemKey: item.item_key ?? null,
    sectionName,
    name: item.name,
    variantId: variant?.id ?? null,
    variantName: variant?.name ?? null,
    options: (config?.modifier_groups ?? []).flatMap((group) => group.options
      .filter((option) => (quantities[option.id] ?? 0) > 0)
      .map((option) => ({ id: option.id, name: option.name, groupName: group.name, quantity: quantities[option.id] }))),
    qty: 1,
    unitPriceMinor,
  };
}

/** The line «+» on a card adds: default size and default add-ons, price from the server later. */
export function quickLine(item: GuestItem, sectionName: string): ChoiceLine {
  return buildLine(item, sectionName, initialVariant(item), initialQuantities(item), null);
}

/**
 * Highlight that flows to the selected choice inside its parent (sizes, a single-choice
 * group) — FLIP on transform only.
 */
function FlowIndicator({ watch, selector }: { watch: unknown; selector: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    const container = ref.current?.parentElement ?? null;
    slideIndicator(ref.current, container, container?.querySelector<HTMLElement>(selector) ?? null, placed.current);
    placed.current = true;
  }, [watch, selector]);
  return <span className="g-indicator" ref={ref} aria-hidden="true" />;
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function optionPrice(option: ModifierGroup["options"][number], variantId: string | null): number {
  return variantId && option.price_by_variant[variantId] !== undefined ? option.price_by_variant[variantId] : option.price_minor;
}

/**
 * Item card as a bottom sheet: photo, description, sizes, add-on groups with the
 * required ones explained, a price from the server only, ♡ and «В мой выбор».
 */
export function ItemSheet({
  item,
  sectionName,
  publicId,
  onClose,
  onAdd,
  favorite,
  onToggleFavorite,
  origin,
  editPath,
}: {
  item: GuestItem;
  sectionName: string;
  publicId: string;
  onClose: () => void;
  /** `from` is where the «Мой выбор» thumbnail starts its flight. */
  onAdd: (line: ChoiceLine, from: Rect | null) => void;
  favorite: boolean;
  onToggleFavorite: () => boolean;
  origin?: SheetOrigin | null;
  /** Cabinet link for an admin of this venue. */
  editPath?: string;
}) {
  const config = item.configuration;
  const groups = config?.modifier_groups ?? [];
  const [variantId, setVariantId] = useState<string | null>(() => initialVariant(item));
  const [quantities, setQuantities] = useState<Quantities>(() => initialQuantities(item));

  const modifiers = useMemo(
    () => Object.entries(quantities).filter(([, quantity]) => quantity > 0).map(([option_id, quantity]) => ({ option_id, quantity })),
    [quantities],
  );
  const problems = groups.filter((group) => groupProblem(group, quantities));
  const variantMissing = Boolean(config?.variants.length) && !variantId;
  const complete = item.is_available && !problems.length && !variantMissing;
  const selection = useDebounced(useMemo(() => ({ variantId, modifiers }), [variantId, modifiers]), 250);
  const settled = selection.variantId === variantId && selection.modifiers === modifiers;

  const quote = useQuery({
    queryKey: ["guest-quote", publicId, item.id, selection.variantId, selection.modifiers],
    queryFn: ({ signal }) => quoteGuestItem(publicId, { itemId: item.id, variantId: selection.variantId, modifiers: selection.modifiers }, signal),
    enabled: complete && settled,
    retry: false,
    staleTime: 30_000,
  });
  const quoteBlocked = quote.isError && quote.error instanceof GuestApiError && (quote.error.status === 409 || quote.error.status === 422);
  const price = complete && settled && quote.data ? quote.data.unit_price_minor : null;

  function choose(update: Quantities) {
    haptics.selection();
    setQuantities((current) => ({ ...current, ...update }));
  }

  function add(event: MouseEvent<HTMLButtonElement>) {
    if (!complete) return;
    const photo = document.querySelector<HTMLElement>(".g-item__photo");
    const source = (photo ?? event.currentTarget).getBoundingClientRect();
    onAdd(buildLine(item, sectionName, variantId, quantities, price), { left: source.left, top: source.top, width: source.width, height: source.height });
  }

  // The price lives in the main button: «В мой выбор · 240 ₽» (server quote only).
  const priceLabel = !complete || quoteBlocked || (quote.isError && price === null)
    ? ""
    : price !== null
      ? formatMoney(price)
      : "…";

  return (
    <MotionSheet
      open
      origin={origin}
      onClose={onClose}
      title={item.name}
      closeLabel="Закрыть карточку"
      footer={(
        <div className="g-item-footer">
          <IconButton
            variant="tonal"
            aria-label={favorite ? "Убрать из любимого" : "В любимое"}
            aria-pressed={favorite}
            className={favorite ? "g-heart g-heart--on" : "g-heart"}
            icon={<Heart size={22} fill={favorite ? "currentColor" : "none"} />}
            onClick={(event) => {
              const target = event.currentTarget;
              if (onToggleFavorite()) heartBurst(target, getComputedStyle(target).color);
            }}
          />
          <Button
            className="g-item-footer__add"
            icon={<Plus size={20} />}
            disabled={!complete || quoteBlocked}
            onClick={add}
          >
            В мой выбор{priceLabel && <span className="g-item-footer__sep" aria-hidden="true"> · </span>}
            <RollingText className="quoted-price" value={priceLabel} />
          </Button>
        </div>
      )}
    >
      <div className="guest-item-dialog g-item">
        {item.image_url && <img className="g-item__photo" src={item.image_url} alt="" />}
        {!item.is_available && <p className="g-badge g-badge--muted g-item__status">Нет в наличии</p>}
        {!item.is_available && <NotifyWhenBackButton publicId={publicId} itemKey={item.item_key} enabled />}
        {(item.description || item.weight_text) && (
          <div className="g-item__intro">
            {item.description && <p>{item.description}</p>}
            {item.weight_text && <small>{item.weight_text}</small>}
          </div>
        )}
        {item.ingredients && <p className="g-item__meta">Состав: {item.ingredients}</p>}
        {item.allergens.length > 0 && <p className="g-item__meta">Аллергены: {item.allergens.join(", ")}</p>}
        {editPath && (
          <Link className="g-item__edit" to={editPath}>
            <Pencil size={16} aria-hidden="true" />
            Редактировать
          </Link>
        )}

        {Boolean(config?.variants.length) && (
          <fieldset className="g-group" disabled={!item.is_available}>
            <legend className="g-group__legend"><span>Размер</span></legend>
            <div className="g-sizes">
              <FlowIndicator watch={variantId} selector=".g-size--on" />
              {config!.variants.map((variant) => (
                <label key={variant.id} className={`g-size${variantId === variant.id ? " g-size--on" : ""}${variant.is_available ? "" : " g-size--off"}`}>
                  <input
                    type="radio"
                    name={`size-${item.id}`}
                    value={variant.id}
                    checked={variantId === variant.id}
                    disabled={!variant.is_available}
                    onChange={() => {
                      haptics.selection();
                      setVariantId(variant.id);
                    }}
                  />
                  <span className="g-size__name">{variant.name}</span>
                  <span className="g-size__price">{variant.is_available ? formatMoney(variant.price_minor) : "Нет"}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {groups.map((group) => {
          const count = groupCount(group, quantities);
          const single = group.max_quantity === 1;
          const forced = group.options.find((option) => option.min_quantity > 0);
          const unmet = problems.includes(group);
          const hintId = `hint-${group.id}`;
          return (
            <fieldset
              key={group.id}
              className={`g-group${unmet && group.min_quantity > 0 ? " g-group--required" : ""}`}
              disabled={!item.is_available}
              aria-describedby={unmet ? hintId : undefined}
            >
              <legend className="g-group__legend">
                <span>{group.name}</span>
                <small className={group.min_quantity ? "g-group__rule g-group__rule--required" : "g-group__rule"}>
                  {group.min_quantity
                    ? `Обязательно${group.max_quantity > 1 ? ` · ${group.min_quantity === group.max_quantity ? group.min_quantity : `${group.min_quantity}–${group.max_quantity}`}` : ""}`
                    : `До ${group.max_quantity}`}
                </small>
              </legend>
              {unmet && <p id={hintId} className="g-group__hint">{requiredHint(group)}</p>}
              <div className="g-options">
                {single && <FlowIndicator watch={group.options.map((option) => quantities[option.id] ?? 0).join(",")} selector=".g-option--on" />}
                {single && group.min_quantity === 0 && !forced && (
                  <label className={`g-option${count === 0 ? " g-option--on" : ""}`}>
                    <input
                      type="radio"
                      name={`group-${group.id}`}
                      checked={count === 0}
                      onChange={() => choose(Object.fromEntries(group.options.map((option) => [option.id, 0])))}
                    />
                    <span className="g-option__name">Без добавки</span>
                  </label>
                )}
                {group.options.map((option) => {
                  const value = quantities[option.id] ?? 0;
                  const extra = optionPrice(option, variantId);
                  const priceText = !option.is_available ? "Нет в наличии" : extra ? `+${formatMoney(extra)}` : "Без доплаты";
                  if (single) {
                    return (
                      <label key={option.id} className={`g-option${value > 0 ? " g-option--on" : ""}${option.is_available ? "" : " g-option--off"}`}>
                        <input
                          type="radio"
                          name={`group-${group.id}`}
                          checked={value > 0}
                          disabled={!option.is_available || option.max_quantity === 0 || Boolean(forced && forced.id !== option.id)}
                          onChange={() => choose(Object.fromEntries(group.options.map((choice) => [choice.id, choice.id === option.id ? 1 : 0])))}
                        />
                        <span className="g-option__name">{option.name}</span>
                        <span className="g-option__price">{priceText}</span>
                      </label>
                    );
                  }
                  return (
                    <div key={option.id} className={`g-option g-option--stepper${option.is_available ? "" : " g-option--off"}`}>
                      <span className="g-option__name">{option.name}</span>
                      <span className="g-option__price">{priceText}</span>
                      <span className="g-stepper">
                        <button
                          type="button"
                          aria-label={`Уменьшить ${option.name}`}
                          disabled={value <= option.min_quantity}
                          onClick={() => choose({ [option.id]: value - 1 })}
                        >
                          <Minus size={16} aria-hidden="true" />
                        </button>
                        <output aria-live="polite">{value}</output>
                        <button
                          type="button"
                          aria-label={`Добавить ${option.name}`}
                          disabled={!option.is_available || value >= option.max_quantity || count >= group.max_quantity}
                          onClick={() => choose({ [option.id]: value + 1 })}
                        >
                          <Plus size={16} aria-hidden="true" />
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </fieldset>
          );
        })}

        {quote.isError && !quoteBlocked && <p className="g-item__error" role="alert">{quote.error.message}</p>}
        {quoteBlocked && <p className="g-item__error" role="alert">Позиция недоступна или меню обновилось</p>}
      </div>
    </MotionSheet>
  );
}
