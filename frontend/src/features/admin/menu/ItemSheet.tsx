import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Plus, SlidersHorizontal, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";

import { aiKeys, describeItem, fetchAiStatus } from "../../../api/ai";
import { revisionConflict } from "../../../api/errors";
import { emptyConfiguration, uploadMenuMedia, type ItemConfiguration, type MenuItem, type ModifierGroup, type ModifierOption } from "../../../api/menu";
import type { Restaurant } from "../../../api/restaurants";
import { patchPointItem, venueKeys, type PointItemState } from "../../../api/venues";
import { Button, Field, IconButton, Sheet, Switch, Textarea, TextInput } from "../../../design";
import { showToast } from "../../../design/toast";
import { haptics } from "../../../max";
import { configurationError } from "../../menu/configuration";
import { parsePrice } from "../../menu/PriceInput";
import type { SaveStatus } from "./useMenuDraft";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);
type Tab = "main" | "sizes" | "modifiers";
const TABS: Array<[Tab, string]> = [["main", "Основное"], ["sizes", "Размеры"], ["modifiers", "Добавки"]];

const rubles = (minor: number) => (Number.isFinite(minor) ? String(minor / 100) : "");

/** Price in roubles typed as text, stored as integer kopecks; NaN while the text is invalid. */
function PriceField({ label, value, onChange, hint, placeholder, allowEmpty, onCommit }: {
  label: string;
  value: number | null;
  onChange?: (value: number) => void;
  hint?: string;
  placeholder?: string;
  /** Empty text is allowed and means «no value» (point price). */
  allowEmpty?: boolean;
  /** Called on blur with the parsed value (point price saves on blur). */
  onCommit?: (value: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? "" : rubles(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (focused) return;
    if (value === null) setText("");
    else if (Number.isFinite(value)) setText(rubles(value));
  }, [value, focused]);
  const empty = !text.trim();
  const parsed = empty ? null : parsePrice(text);
  const invalid = empty ? !allowEmpty : parsed === null;
  return (
    <TextInput
      label={label}
      inputMode="decimal"
      maxLength={11}
      placeholder={placeholder}
      value={text}
      hint={hint}
      error={invalid ? (empty ? "Укажите цену" : "От 0 до 1 000 000 ₽, до двух знаков после запятой") : undefined}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (!invalid) onCommit?.(parsed);
      }}
      onChange={(event) => {
        setText(event.target.value);
        const next = event.target.value.trim() ? parsePrice(event.target.value) : null;
        onChange?.(next ?? Number.NaN);
      }}
    />
  );
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <TextInput label={label} type="number" inputMode="numeric" min={0} max={20} value={Number.isFinite(value) ? value : ""} onChange={(event) => onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))} />
  );
}

const newOption = (): ModifierOption => ({ id: crypto.randomUUID(), name: "Новая добавка", price_minor: 0, min_quantity: 0, max_quantity: 1, default_quantity: 0, is_available: true, price_by_variant: {} });

/**
 * Item card of the cabinet (P1-TASK-28, P1-DOC-7): a sheet grown out of the tapped row
 * (shared element, P1-DOC-18) with tabs Основное · Размеры · Добавки. Every edit goes straight
 * to the draft (autosave), so switching tabs, closing or a 409 conflict loses nothing.
 * Escape, the backdrop and MAX «Назад» close it; focus returns to the row.
 */
export function ItemSheet({ open, item, origin, point, pointState, status, menuId, revision, sectionName, onChange, onClose }: {
  open: boolean;
  item: MenuItem | null;
  origin: HTMLElement | null;
  point: Restaurant;
  pointState: PointItemState | null;
  status: SaveStatus;
  /** Menu and last saved draft revision: the AI description is checked against it. */
  menuId: string | null;
  revision: string;
  sectionName: string | null;
  onChange: (patch: Partial<MenuItem>) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const last = useRef<MenuItem | null>(item);
  if (item) last.current = item;
  const shown = item ?? last.current;
  const [tab, setTab] = useState<Tab>("main");
  const itemId = item?.id;
  useEffect(() => {
    if (open) setTab("main");
  }, [itemId, open]);

  const upload = useMutation({
    mutationFn: (file: File) => {
      if (!IMAGE_TYPES.has(file.type)) throw new Error("Выберите изображение в формате JPG или PNG");
      return uploadMenuMedia(point.id, file);
    },
    onSuccess: (media) => {
      haptics.notify("success");
      onChange({ image_url: media.url });
    },
    onError: () => haptics.notify("error"),
  });
  const pointPrice = useMutation({
    mutationFn: (price: number | null) => patchPointItem(point.id, pointState!.item_key, { price_minor: price }),
    onSuccess: (_result, price) => {
      showToast(price === null ? "Цена точки сброшена — как в меню" : `Цена в точке «${point.name}» сохранена`, { tone: "success" });
      void queryClient.invalidateQueries({ queryKey: venueKeys.items(point.id) });
    },
    onError: (error) => showToast(error.message, { tone: "danger" }),
  });

  const aiStatus = useQuery({ queryKey: aiKeys.status, queryFn: fetchAiStatus, staleTime: 60_000, enabled: open });
  // «Написать описание» (P1-TASK-42): the AI only suggests; the text goes into the form and
  // reaches the draft with the usual autosave. Previous text can be restored from the toast.
  const describe = useMutation({
    mutationFn: (source: MenuItem) => {
      const sourceConfig = source.configuration ?? emptyConfiguration();
      return describeItem(menuId!, revision, {
        name: source.name.trim(),
        section: sectionName,
        ingredients: source.ingredients ?? null,
        weight_text: source.weight_text ?? null,
        sizes: sourceConfig.variants.map((variant) => variant.name).filter(Boolean),
        modifiers: sourceConfig.modifier_groups.map((group) => group.name).filter(Boolean),
      });
    },
    onSuccess: (result, source) => {
      const before = source.description ?? null;
      haptics.notify("success");
      onChange({ description: result.description });
      showToast(result.provider === "mock" ? "Демо-описание добавлено — проверьте текст" : "Описание добавлено — проверьте текст", {
        tone: "success",
        action: { label: "Отменить", onClick: () => onChange({ description: before }) },
      });
    },
    onError: () => haptics.notify("error"),
  });

  if (!shown) return null;
  const config: ItemConfiguration = shown.configuration ?? emptyConfiguration();
  const updateConfig = (patch: Partial<ItemConfiguration>) => onChange({ configuration: { ...config, ...patch } });
  const updateGroup = (id: string, patch: Partial<ModifierGroup>) => updateConfig({ modifier_groups: config.modifier_groups.map((group) => (group.id === id ? { ...group, ...patch } : group)) });
  const updateOption = (group: ModifierGroup, id: string, patch: Partial<ModifierOption>) => updateGroup(group.id, { options: group.options.map((option) => (option.id === id ? { ...option, ...patch } : option)) });
  const configError = configurationError(config);
  const nameError = !shown.name.trim() ? "Введите название — без него позицию не сохранить" : undefined;

  const removeVariant = (variantId: string) => {
    const before = config;
    const variant = config.variants.find((entry) => entry.id === variantId);
    updateConfig({
      variants: config.variants.filter((entry) => entry.id !== variantId),
      default_variant_id: config.default_variant_id === variantId ? null : config.default_variant_id,
      modifier_groups: config.modifier_groups.map((group) => ({
        ...group,
        options: group.options.map((option) => ({ ...option, price_by_variant: Object.fromEntries(Object.entries(option.price_by_variant).filter(([id]) => id !== variantId)) })),
      })),
    });
    showToast(`Размер «${variant?.name ?? ""}» удалён`, { action: { label: "Отменить", onClick: () => onChange({ configuration: before }) } });
  };
  const removeGroup = (groupId: string) => {
    const before = config;
    const group = config.modifier_groups.find((entry) => entry.id === groupId);
    updateConfig({ modifier_groups: config.modifier_groups.filter((entry) => entry.id !== groupId) });
    showToast(`Группа «${group?.name ?? ""}» удалена`, { action: { label: "Отменить", onClick: () => onChange({ configuration: before }) } });
  };

  const tabIndex = TABS.findIndex(([key]) => key === tab);
  const footerText = configError ?? (nameError ? "Проверьте название" : null) ?? (status === "saving" ? "Сохраняем…" : status === "conflict" ? "Конфликт — правки сохранены на устройстве" : status === "error" ? "Не сохранено" : "Сохраняется автоматически");
  return (
    <Sheet
      open={open}
      onClose={onClose}
      origin={origin}
      wide
      title={shown.name || "Новая позиция"}
      closeLabel="Закрыть карточку"
      toolbar={(
        <nav className="item-tabs" aria-label="Настройки позиции" style={{ "--tab-index": tabIndex } as CSSProperties}>
          <span className="item-tabs__indicator" aria-hidden="true" />
          {TABS.map(([key, title]) => {
            const count = key === "sizes" ? config.variants.length : key === "modifiers" ? config.modifier_groups.length : 0;
            return (
              <button key={key} type="button" className="item-tabs__tab" aria-current={tab === key ? "page" : undefined} onClick={() => { haptics.selection(); setTab(key); }}>
                {title}{count ? <span className="item-tabs__count"> {count}</span> : null}
              </button>
            );
          })}
        </nav>
      )}
      footer={(
        <>
          <span className={["item-footer__status", (configError || nameError || status === "conflict" || status === "error") && "item-footer__status--error"].filter(Boolean).join(" ")} role="status">{footerText}</span>
          <Button onClick={onClose}>Готово</Button>
        </>
      )}
    >
      {tab === "main" && (
        <div className="item-form">
          <div className={["item-photo", shown.image_url && "item-photo--filled"].filter(Boolean).join(" ")}>
            {shown.image_url && <img src={shown.image_url} alt={shown.name} />}
            <label className="item-photo__pick">
              <input
                type="file"
                accept="image/jpeg,image/png"
                aria-label={shown.image_url ? "Заменить фотографию блюда" : "Добавить фотографию блюда"}
                disabled={upload.isPending}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) upload.mutate(file);
                  event.target.value = "";
                }}
              />
              <ImagePlus size={24} aria-hidden="true" />
              <span><strong>{upload.isPending ? "Загружаем…" : shown.image_url ? "Заменить фото" : "Добавить фото"}</strong><small>JPG или PNG · большие уменьшим сами</small></span>
            </label>
            {shown.image_url && <IconButton className="item-photo__remove" aria-label="Убрать фото" icon={<Trash2 size={20} />} onClick={() => onChange({ image_url: null })} />}
          </div>
          {upload.isError && <p className="cabinet-error" role="alert">{upload.error.message}</p>}
          <TextInput label="Название" required maxLength={250} value={shown.name} onChange={(event) => onChange({ name: event.target.value })} error={nameError} data-autofocus={shown.name ? undefined : true} />
          <div className="item-columns">
            <PriceField label={config.variants.length ? "Базовая цена, ₽" : "Цена, ₽"} value={shown.price_minor} onChange={(price_minor) => onChange({ price_minor })} hint={config.variants.length ? "Гость платит цену размера" : undefined} />
            <TextInput label="Вес / объём" maxLength={100} placeholder="250 мл" value={shown.weight_text ?? ""} onChange={(event) => onChange({ weight_text: event.target.value || null })} />
          </div>
          <Textarea label="Описание" rows={3} maxLength={2000} placeholder="Эспрессо, молоко, лавандовый сироп" value={shown.description ?? ""} onChange={(event) => onChange({ description: event.target.value || null })} />
          {aiStatus.data?.available ? (
            <div className="item-ai">
              <Button
                variant="secondary"
                icon={<Sparkles size={20} />}
                loading={describe.isPending}
                disabled={!menuId || !shown.name.trim() || !revision}
                onClick={() => describe.mutate(shown)}
              >
                {shown.description ? "Переписать описание" : "Написать описание"}
              </Button>
              <span className="item-ai__hint">
                {aiStatus.data.provider === "mock" ? "Демо-ИИ · " : ""}По названию, составу и размерам, до 160 символов
              </span>
            </div>
          ) : aiStatus.data ? (
            <p className="item-ai__hint" role="status">ИИ сейчас недоступен — напишите описание вручную.</p>
          ) : null}
          {describe.isError && (
            <p className="cabinet-error" role="alert">
              {revisionConflict(describe.error) ? "Меню изменилось на другом устройстве — дождитесь сохранения и попробуйте снова" : describe.error.message}
            </p>
          )}
          <div className="item-switches">
            <Switch checked={shown.is_available} onChange={(is_available) => onChange({ is_available })} label="В меню" description="Выключите, чтобы скрыть позицию во всех точках после публикации" />
          </div>
          {pointState && !config.variants.length && (
            <PriceField
              label={`Цена в точке «${point.name}», ₽`}
              value={pointState.override?.price_minor ?? null}
              placeholder={rubles(pointState.menu_price_minor)}
              allowEmpty
              hint="Пусто — цена из меню. Меняется сразу, без публикации."
              onCommit={(price) => {
                if (price !== (pointState.override?.price_minor ?? null)) pointPrice.mutate(price);
              }}
            />
          )}
        </div>
      )}

      {tab === "sizes" && (
        <div className="item-form">
          <p className="cabinet-muted">У каждого размера своя цена: она заменяет базовую. Отметьте размер по умолчанию.</p>
          {!config.variants.length && <p className="item-empty"><SlidersHorizontal size={20} aria-hidden="true" />Например: 250, 350 и 450 мл</p>}
          {config.variants.map((variant) => (
            <section key={variant.id} className="item-card" aria-label={`Размер ${variant.name}`}>
              <div className="item-columns">
                <TextInput label="Размер" maxLength={100} value={variant.name} onChange={(event) => updateConfig({ variants: config.variants.map((entry) => (entry.id === variant.id ? { ...entry, name: event.target.value } : entry)) })} error={variant.name.trim() ? undefined : "Назовите размер"} />
                <PriceField label="Цена, ₽" value={variant.price_minor} onChange={(price_minor) => updateConfig({ variants: config.variants.map((entry) => (entry.id === variant.id ? { ...entry, price_minor } : entry)) })} />
              </div>
              <div className="item-card__row">
                <label className="item-radio">
                  <input type="radio" name={`default-size-${shown.id}`} checked={config.default_variant_id === variant.id} onChange={() => updateConfig({ default_variant_id: variant.id })} />
                  По умолчанию
                </label>
                <Switch compact checked={variant.is_available} onChange={(is_available) => updateConfig({ variants: config.variants.map((entry) => (entry.id === variant.id ? { ...entry, is_available } : entry)) })} label={`Размер ${variant.name} в наличии`} />
                <IconButton aria-label={`Удалить размер ${variant.name}`} icon={<Trash2 size={20} />} onClick={() => removeVariant(variant.id)} />
              </div>
            </section>
          ))}
          <Button
            variant="ghost"
            icon={<Plus size={20} />}
            disabled={config.variants.length >= 20}
            onClick={() => {
              const id = crypto.randomUUID();
              updateConfig({ variants: [...config.variants, { id, name: config.variants.length ? "Новый размер" : "250 мл", price_minor: Number.isFinite(shown.price_minor) ? shown.price_minor : 0, weight_text: null, is_available: true }], default_variant_id: config.default_variant_id ?? id });
            }}
          >
            Добавить размер
          </Button>
        </div>
      )}

      {tab === "modifiers" && (
        <div className="item-form">
          <p className="cabinet-muted">Группа «Молоко» с обязательным выбором или необязательные сиропы. Минимум и максимум — сколько добавок группы можно взять к одной позиции.</p>
          {!config.modifier_groups.length && <p className="item-empty"><SlidersHorizontal size={20} aria-hidden="true" />Молоко, сиропы, топпинги</p>}
          {config.modifier_groups.map((group) => (
            <ModifierGroupCard
              key={group.id}
              group={group}
              variants={config.variants}
              onGroup={(patch) => updateGroup(group.id, patch)}
              onOption={(id, patch) => updateOption(group, id, patch)}
              onRemove={() => removeGroup(group.id)}
            />
          ))}
          <Button
            variant="ghost"
            icon={<Plus size={20} />}
            disabled={config.modifier_groups.length >= 20}
            onClick={() => updateConfig({ modifier_groups: [...config.modifier_groups, { id: crypto.randomUUID(), name: "Новая группа", min_quantity: 0, max_quantity: 1, options: [newOption()] }] })}
          >
            Добавить группу
          </Button>
          {configError && <p className="cabinet-error" role="alert">{configError}</p>}
        </div>
      )}
    </Sheet>
  );
}

function ModifierGroupCard({ group, variants, onGroup, onOption, onRemove }: {
  group: ModifierGroup;
  variants: ItemConfiguration["variants"];
  onGroup: (patch: Partial<ModifierGroup>) => void;
  onOption: (id: string, patch: Partial<ModifierOption>) => void;
  onRemove: () => void;
}) {
  const limitsId = useId();
  const limitsError = !Number.isInteger(group.min_quantity) || !Number.isInteger(group.max_quantity) || group.min_quantity > group.max_quantity
    ? "Минимум не больше максимума, от 0 до 20"
    : undefined;
  return (
    <section className="item-card modifier-group" aria-label={`Группа ${group.name}`}>
      <div className="item-card__row">
        <div className="item-card__grow">
          <TextInput label="Название группы" maxLength={100} value={group.name} onChange={(event) => onGroup({ name: event.target.value })} error={group.name.trim() ? undefined : "Назовите группу"} />
        </div>
        <IconButton aria-label={`Удалить группу ${group.name}`} icon={<Trash2 size={20} />} onClick={onRemove} />
      </div>
      <Switch
        checked={group.min_quantity > 0}
        onChange={(required) => onGroup({ min_quantity: required ? 1 : 0, max_quantity: Math.max(1, group.max_quantity) })}
        label="Обязательная"
        description="Гость не сможет выбрать позицию, пока не выберет добавку"
      />
      <div className="item-columns" aria-describedby={limitsError ? limitsId : undefined}>
        <Stepper label="Мин." value={group.min_quantity} onChange={(min_quantity) => onGroup({ min_quantity })} />
        <Stepper label="Макс." value={group.max_quantity} onChange={(max_quantity) => onGroup({ max_quantity })} />
      </div>
      {limitsError && <p id={limitsId} className="cabinet-error" role="alert">{limitsError}</p>}
      <div className="item-options">
        {group.options.map((option) => (
          <div key={option.id} className="modifier-option">
            <div className="item-option__main">
              <TextInput label="Добавка" maxLength={100} value={option.name} onChange={(event) => onOption(option.id, { name: event.target.value })} error={option.name.trim() ? undefined : "Назовите добавку"} />
              <PriceField label="Доплата, ₽" value={option.price_minor} onChange={(price_minor) => onOption(option.id, { price_minor })} />
              <IconButton
                aria-label={`Удалить добавку ${option.name}`}
                icon={<Trash2 size={20} />}
                disabled={group.options.length === 1}
                onClick={() => onGroup({ options: group.options.filter((entry) => entry.id !== option.id) })}
              />
            </div>
            <details className="item-option__more">
              <summary>Лимиты и цены по размерам</summary>
              <div className="item-option__limits">
                <Stepper label="Мин." value={option.min_quantity} onChange={(min_quantity) => onOption(option.id, { min_quantity })} />
                <Stepper label="Макс." value={option.max_quantity} onChange={(max_quantity) => onOption(option.id, { max_quantity })} />
                <Stepper label="По умолчанию" value={option.default_quantity} onChange={(default_quantity) => onOption(option.id, { default_quantity })} />
              </div>
              <Switch checked={option.is_available} onChange={(is_available) => onOption(option.id, { is_available })} label="В наличии" />
              {variants.map((variant) => {
                const own = variant.id in option.price_by_variant;
                return (
                  <div key={variant.id} className="item-option__size">
                    <Switch
                      checked={own}
                      label={`Своя доплата для ${variant.name}`}
                      onChange={(on) => {
                        const prices = { ...option.price_by_variant };
                        if (on) prices[variant.id] = option.price_minor;
                        else delete prices[variant.id];
                        onOption(option.id, { price_by_variant: prices });
                      }}
                    />
                    {own && (
                      <Field label={`Доплата для ${variant.name}, ₽`}>
                        {(control) => (
                          <input
                            {...control}
                            className="s-input"
                            inputMode="decimal"
                            defaultValue={rubles(option.price_by_variant[variant.id])}
                            onChange={(event) => onOption(option.id, { price_by_variant: { ...option.price_by_variant, [variant.id]: parsePrice(event.target.value) ?? Number.NaN } })}
                          />
                        )}
                      </Field>
                    )}
                  </div>
                );
              })}
            </details>
          </div>
        ))}
      </div>
      <Button variant="ghost" icon={<Plus size={20} />} disabled={group.options.length >= 30} onClick={() => onGroup({ options: [...group.options, newOption()] })}>Добавка</Button>
    </section>
  );
}
