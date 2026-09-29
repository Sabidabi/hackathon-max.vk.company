import { EllipsisVertical, Plus } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import type { MenuItem, MenuSection } from "../../../api/menu";
import { IconButton, Switch } from "../../../design";
import { shake } from "../../../design/motion";
import { haptics } from "../../../max";
import { displayPrice } from "../../menu/configuration";
import { hasPrice } from "./MenuStart";
import { parsePrice } from "../../menu/PriceInput";

/** «Латте 190», «Раф лавандовый 245,50 ₽» → name and price in kopecks; null without a price. */
export function parseQuickItem(text: string): { name: string; price_minor: number } | null {
  const match = /^(.*\S)\s+(\d{1,7}(?:[.,]\d{1,2})?)\s*(?:₽|р\.?|руб\.?)?$/i.exec(text.trim());
  if (!match) return null;
  const price = parsePrice(match[2]);
  const name = match[1].trim();
  return price === null || !name ? null : { name: name.slice(0, 250), price_minor: price };
}

function itemDetails(item: MenuItem): string {
  const sizes = item.configuration?.variants.length ?? 0;
  const groups = item.configuration?.modifier_groups.length ?? 0;
  return [item.weight_text, sizes ? `${sizes} ${sizes === 1 ? "размер" : sizes < 5 ? "размера" : "размеров"}` : null, groups ? "добавки" : null]
    .filter(Boolean)
    .join(" · ");
}

export interface RowState {
  available: boolean;
  /** The switch changes the stop-list of the point (true) or the draft (false: not published yet). */
  pointLevel: boolean;
  busy: boolean;
  error: string | null;
}

/** Compact row: photo, name, details, price, the availability switch of the current point, «⋮». */
export function ItemRow({ item, state, pointName, onOpen, onToggle, onActions }: {
  item: MenuItem;
  state: RowState;
  pointName: string;
  onOpen: (origin: HTMLElement) => void;
  onToggle: (next: boolean) => void;
  onActions: () => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const details = itemDetails(item);
  const priced = hasPrice(item);
  return (
    <div ref={rowRef} className={["menu-row", !state.available && "menu-row--off"].filter(Boolean).join(" ")} data-flip={item.id}>
      <button type="button" className="menu-row__main" aria-label={`Редактировать ${item.name}`} onClick={() => onOpen(rowRef.current!)}>
        {item.image_url && <img className="menu-row__photo" src={item.image_url} alt="" loading="lazy" />}
        <span className="menu-row__text">
          <strong>{item.name || "Без названия"}</strong>
          {!priced && state.available
            ? <small className="menu-row__missing">Нет цены</small>
            : (details || !state.available) && <small>{!state.available ? (state.error ?? "Нет в наличии") : details}</small>}
        </span>
        <span className="menu-row__price">{priced ? displayPrice(item) : "—"}</span>
      </button>
      <Switch
        compact
        checked={state.available}
        busy={state.busy}
        label={`${item.name}: в наличии${state.pointLevel ? ` на точке «${pointName}»` : ""}`}
        onChange={(next) => {
          haptics.selection();
          onToggle(next);
        }}
      />
      <IconButton aria-label={`Действия: ${item.name}`} icon={<EllipsisVertical size={20} />} onClick={onActions} />
    </div>
  );
}

/** «Латте 190» + Enter: the position is created and the field is ready for the next one (P1-DOC-17). */
export function QuickAdd({ section, onAdd, disabled }: { section: MenuSection; onAdd: (name: string, price: number) => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = () => {
    if (!text.trim()) return;
    const parsed = parseQuickItem(text);
    if (!parsed) {
      setError("Добавьте цену через пробел: «Латте 190»");
      haptics.notify("error");
      shake(inputRef.current);
      return;
    }
    haptics.impact("light");
    onAdd(parsed.name, parsed.price_minor);
    setText("");
    setError(null);
    inputRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  };
  const id = `quick-${section.id}`;
  return (
    <div className={["menu-quick", error && "menu-quick--invalid"].filter(Boolean).join(" ")}>
      <label className="s-visually-hidden" htmlFor={id}>Новая позиция в разделе «{section.name}»: название и цена</label>
      <span className="menu-quick__icon" aria-hidden="true"><Plus size={20} /></span>
      <input
        ref={inputRef}
        id={id}
        className="menu-quick__input"
        placeholder="Позиция и цена: Латте 190"
        value={text}
        maxLength={270}
        disabled={disabled}
        enterKeyHint="done"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => { setText(event.target.value); if (error) setError(null); }}
        onKeyDown={onKeyDown}
      />
      {text.trim() && <button type="button" className="menu-quick__submit" onClick={submit}>Добавить</button>}
      {error && <p id={`${id}-error`} className="menu-quick__error" role="alert">{error}</p>}
    </div>
  );
}
