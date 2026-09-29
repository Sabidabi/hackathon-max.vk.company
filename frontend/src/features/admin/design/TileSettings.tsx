import { Check } from "lucide-react";
import type { ReactNode } from "react";

import type {
  AddButton,
  BodyFont,
  CardRadius,
  CardStyle,
  HeadingFont,
  ImageRatio,
  MenuLayout,
  SiteConfig,
} from "../../../api/site";
import { haptics } from "../../../max";

interface Option<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Sample text drawn in the font itself (font options). */
  sample?: string;
  family?: string;
}

function Group<T extends string>({ title, value, options, onChange, columns }: {
  title: string;
  value: T;
  options: Array<Option<T>>;
  onChange: (value: T) => void;
  columns?: number;
}) {
  return (
    <div className="tile-group" role="radiogroup" aria-label={title}>
      <p className="tile-group__title">{title}</p>
      <div className="tile-group__options" style={{ gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))` }}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            className="tile-option"
            onClick={() => {
              haptics.selection();
              onChange(option.value);
            }}
          >
            {option.icon && <span className="tile-option__icon" aria-hidden="true">{option.icon}</span>}
            {option.sample && <span className="tile-option__sample" style={{ fontFamily: option.family }} aria-hidden="true">{option.sample}</span>}
            <span className="tile-option__label">{option.label}</span>
            {value === option.value && <Check className="tile-option__check" size={14} strokeWidth={3} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Mini-drawing of a layout: two columns / one wide row / one big tile. */
const Mini = ({ kind }: { kind: "grid" | "list" | "large" }) => (
  <span className={`tile-mini tile-mini--${kind}`}><i /><i /><i /><i /></span>
);

const LAYOUTS: Array<Option<MenuLayout>> = [
  { value: "grid", label: "Сетка", icon: <Mini kind="grid" /> },
  { value: "list", label: "Список", icon: <Mini kind="list" /> },
  { value: "large", label: "Крупные", icon: <Mini kind="large" /> },
];
const STYLES: Array<Option<CardStyle>> = [
  { value: "soft", label: "Мягкие" },
  { value: "outline", label: "Контур" },
  { value: "flat", label: "Заливка" },
];
const RADII: Array<Option<CardRadius>> = [
  { value: "sharp", label: "Острые" },
  { value: "soft", label: "Мягкие" },
  { value: "round", label: "Круглые" },
];
const RATIOS: Array<Option<ImageRatio>> = [
  { value: "square", label: "Квадрат" },
  { value: "landscape", label: "Широкое" },
  { value: "portrait", label: "Высокое" },
];
const ADD_BUTTONS: Array<Option<AddButton>> = [
  { value: "round", label: "Кружок «+»" },
  { value: "pill", label: "С подписью" },
];

const HEADING_FONTS: Array<Option<HeadingFont>> = [
  { value: "sans", label: "Строгий", sample: "Латте", family: "Arial, Helvetica, sans-serif" },
  { value: "humanist", label: "Мягкий", sample: "Латте", family: '"Avenir Next", "Segoe UI", "Trebuchet MS", sans-serif' },
  { value: "rounded", label: "Округлый", sample: "Латте", family: 'ui-rounded, "Arial Rounded MT Bold", "Nunito", "Segoe UI", sans-serif' },
  { value: "serif", label: "С засечками", sample: "Латте", family: 'Georgia, "Times New Roman", serif' },
  { value: "elegant", label: "Изящный", sample: "Латте", family: '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif' },
  { value: "mono", label: "Печатный", sample: "Латте", family: '"Courier New", ui-monospace, monospace' },
];
const BODY_FONTS: Array<Option<BodyFont>> = [
  { value: "sans", label: "Строгий", sample: "Эспрессо", family: "Arial, Helvetica, sans-serif" },
  { value: "humanist", label: "Мягкий", sample: "Эспрессо", family: '"Avenir Next", "Segoe UI", "Trebuchet MS", sans-serif' },
  { value: "serif", label: "С засечками", sample: "Эспрессо", family: 'Georgia, "Times New Roman", serif' },
];

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="tile-toggle">
      <span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => {
          haptics.selection();
          onChange(event.target.checked);
        }}
      />
    </label>
  );
}

/** «Плитки» and «Шрифт» of the menu constructor: every change is drawn at once in the phone preview. */
export function TileSettings({ config, patch }: { config: SiteConfig; patch: (next: Partial<SiteConfig>) => void }) {
  return (
    <>
      <section aria-labelledby="design-tiles-title" className="design-block">
        <h2 id="design-tiles-title">Плитки</h2>
        <Group title="Расположение" value={config.menu_layout ?? "grid"} options={LAYOUTS} onChange={(menu_layout) => patch({ menu_layout })} />
        <Group title="Карточка" value={config.card_style ?? "soft"} options={STYLES} onChange={(card_style) => patch({ card_style })} />
        <Group title="Скругление" value={config.card_radius ?? "soft"} options={RADII} onChange={(card_radius) => patch({ card_radius })} />
        <Group title="Фото" value={config.image_ratio ?? "square"} options={RATIOS} onChange={(image_ratio) => patch({ image_ratio })} />
        <Group title="Кнопка добавления" value={config.add_button ?? "round"} options={ADD_BUTTONS} onChange={(add_button) => patch({ add_button })} />
        <div className="tile-toggles">
          <Toggle label="Описание" hint="Две строки под названием" checked={config.show_description ?? true} onChange={(show_description) => patch({ show_description })} />
          <Toggle label="Вес или объём" checked={config.show_weight ?? true} onChange={(show_weight) => patch({ show_weight })} />
        </div>
      </section>

      <section aria-labelledby="design-font-title" className="design-block">
        <h2 id="design-font-title">Шрифт</h2>
        <Group title="Заголовки и названия" value={config.heading_font ?? "sans"} options={HEADING_FONTS} onChange={(heading_font) => patch({ heading_font })} columns={3} />
        <Group title="Текст" value={config.body_font ?? "sans"} options={BODY_FONTS} onChange={(body_font) => patch({ body_font })} />
        <p className="cabinet-muted">Шрифты уже есть на телефоне гостя, поэтому меню открывается без задержки.</p>
      </section>
    </>
  );
}
