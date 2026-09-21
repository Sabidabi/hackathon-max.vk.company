import { useState } from "react";
import { ImagePlus, Plus, Trash2, Coffee, SlidersHorizontal } from "lucide-react";
import { emptyConfiguration, type MenuItem, type ModifierGroup, type ModifierOption } from "../../api/menu";
import { Modal } from "../../components/Modal";
import { Help } from "../../components/Help";
import { PriceInput } from "./PriceInput";
import { configurationError } from "./configuration";

const newOption = (): ModifierOption => ({ id: crypto.randomUUID(), name: "Новая добавка", price_minor: 0, min_quantity: 0, max_quantity: 1, default_quantity: 0, is_available: true, price_by_variant: {} });
export function ItemDialog({ item, onChange, onClose, onUpload, uploading, uploadError, saving }: {
  item: MenuItem; onChange: (patch: Partial<MenuItem>) => void; onClose: () => void; onUpload: (file: File) => void; uploading: boolean; uploadError?: string; saving: boolean;
}) {
  const [tab, setTab] = useState("main"); const config = item.configuration ?? emptyConfiguration();
  const updateConfig = (patch: Partial<typeof config>) => onChange({ configuration: { ...config, ...patch } });
  const updateGroup = (id: string, patch: Partial<ModifierGroup>) => updateConfig({ modifier_groups: config.modifier_groups.map((group) => group.id === id ? { ...group, ...patch } : group) });
  const updateOption = (group: ModifierGroup, id: string, patch: Partial<ModifierOption>) => updateGroup(group.id, { options: group.options.map((option) => option.id === id ? { ...option, ...patch } : option) });
  const error = configurationError(config);
  return <Modal title={item.name || "Новая позиция"} onClose={onClose}>
    <nav className="detail-tabs" aria-label="Настройки позиции">{[["main", "Основное"], ["sizes", "Размеры"], ["modifiers", "Добавки"]].map(([id, title]) => <button type="button" aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)} key={id}>{title}</button>)}</nav>
    <div className="dialog-body">
      {tab === "main" && <div className="item-main-form">
        <div className="item-photo-field">
          <label className="item-photo-uploader">
            {item.image_url ? <img src={item.image_url} alt={item.name} /> : <span className="item-photo-placeholder"><ImagePlus size={28} /></span>}
            <span><strong>{uploading ? "Загружаем…" : item.image_url ? "Заменить фото" : "Добавить фото"}</strong><small>JPG или PNG · до 8 МБ</small></span>
            <input aria-label={item.image_url ? "Заменить фотографию блюда" : "Добавить фотографию блюда"} type="file" accept="image/jpeg,image/png" disabled={uploading} onChange={(event) => { if (event.target.files?.[0]) onUpload(event.target.files[0]); event.target.value = ""; }} />
          </label>
          {item.image_url && <button type="button" className="icon-button" aria-label="Убрать фото" onClick={() => onChange({ image_url: null })}><Trash2 size={16} /></button>}
        </div>
        {uploadError && <p className="form-error" role="alert">{uploadError}</p>}
        <label>Название<input maxLength={250} value={item.name} onChange={(event) => onChange({ name: event.target.value })} /></label>
        <div className="form-columns"><label>Цена, ₽<PriceInput value={item.price_minor} onChange={(price_minor) => onChange({ price_minor })} /></label><label>Вес / объём<input maxLength={100} placeholder="250 мл" value={item.weight_text ?? ""} onChange={(event) => onChange({ weight_text: event.target.value || null })} /></label></div>
        <label>Описание<textarea rows={3} maxLength={2000} value={item.description ?? ""} onChange={(event) => onChange({ description: event.target.value || null })} /></label>
        <label className="switch-label"><input type="checkbox" checked={item.is_available} onChange={(event) => onChange({ is_available: event.target.checked })} />В наличии</label>
      </div>}
      {tab === "sizes" && <div className="configuration-list">
        <div className="subsection-heading"><h3>Размеры <span>{config.variants.length || ""}</span></h3><Help label="О размерах">Каждый размер имеет собственную цену. Она заменяет базовую цену позиции. Отметьте размер по умолчанию.</Help></div>
        {!config.variants.length && <div className="compact-empty"><Coffee size={28} /><span>Например: 250, 350 и 450 мл</span></div>}
        {config.variants.map((variant) => <div className="variant-card" key={variant.id}>
          <div className="form-columns"><label>Размер<input value={variant.name} maxLength={100} onChange={(event) => updateConfig({ variants: config.variants.map((v) => v.id === variant.id ? { ...v, name: event.target.value } : v) })} /></label><label>Цена, ₽<PriceInput value={variant.price_minor} onChange={(price_minor) => updateConfig({ variants: config.variants.map((v) => v.id === variant.id ? { ...v, price_minor } : v) })} /></label></div>
          <div className="variant-meta"><label className="switch-label"><input type="radio" name="default-size" checked={config.default_variant_id === variant.id} onChange={() => updateConfig({ default_variant_id: variant.id })} />По умолчанию</label><label className="switch-label"><input type="checkbox" checked={variant.is_available} onChange={(event) => updateConfig({ variants: config.variants.map((v) => v.id === variant.id ? { ...v, is_available: event.target.checked } : v) })} />В наличии</label><button type="button" className="icon-button danger" aria-label={`Удалить размер ${variant.name}`} onClick={() => {
            if (!window.confirm(`Удалить размер «${variant.name}»?`)) return;
            updateConfig({ variants: config.variants.filter((v) => v.id !== variant.id), default_variant_id: config.default_variant_id === variant.id ? null : config.default_variant_id, modifier_groups: config.modifier_groups.map((g) => ({ ...g, options: g.options.map((o) => ({ ...o, price_by_variant: Object.fromEntries(Object.entries(o.price_by_variant).filter(([id]) => id !== variant.id)) })) })) });
          }}><Trash2 size={16} /></button></div>
        </div>)}
        <button type="button" className="button-quiet" disabled={config.variants.length >= 20} onClick={() => { const id = crypto.randomUUID(); updateConfig({ variants: [...config.variants, { id, name: "Новый размер", price_minor: item.price_minor, weight_text: null, is_available: true }], default_variant_id: config.default_variant_id ?? id }); }}><Plus size={16} />Добавить размер</button>
      </div>}
      {tab === "modifiers" && <div className="configuration-list">
        <div className="subsection-heading"><h3>Группы добавок</h3><Help label="О модификаторах">Создайте группу «Молоко» с обязательным выбором или необязательные добавки. Минимум и максимум — суммарное количество добавок из группы на одну позицию.</Help></div>
        {!config.modifier_groups.length && <div className="compact-empty"><SlidersHorizontal size={28} /><span>Молоко, сиропы, топпинги</span></div>}
        {config.modifier_groups.map((group) => <section className="modifier-group" key={group.id}>
          <div className="group-heading"><input aria-label="Название группы" maxLength={100} value={group.name} onChange={(event) => updateGroup(group.id, { name: event.target.value })} /><button type="button" className="icon-button danger" aria-label={`Удалить группу ${group.name}`} onClick={() => { if (window.confirm(`Удалить группу «${group.name}»?`)) updateConfig({ modifier_groups: config.modifier_groups.filter((g) => g.id !== group.id) }); }}><Trash2 size={16} /></button></div>
          <div className="group-limits"><label className="switch-label"><input type="checkbox" checked={group.min_quantity > 0} onChange={(event) => updateGroup(group.id, { min_quantity: event.target.checked ? 1 : 0, max_quantity: Math.max(1, group.max_quantity) })} />Обязательная</label><label>Мин.<input type="number" min={0} max={20} value={group.min_quantity} onChange={(event) => updateGroup(group.id, { min_quantity: Number(event.target.value) })} /></label><label>Макс.<input type="number" min={0} max={20} value={group.max_quantity} onChange={(event) => updateGroup(group.id, { max_quantity: Number(event.target.value) })} /></label></div>
          {group.options.map((option) => <div className="modifier-option" key={option.id}>
            <div className="option-main"><label>Добавка<input value={option.name} maxLength={100} onChange={(event) => updateOption(group, option.id, { name: event.target.value })} /></label><label>Доплата, ₽<PriceInput value={option.price_minor} onChange={(price_minor) => updateOption(group, option.id, { price_minor })} /></label><button type="button" className="icon-button danger" aria-label={`Удалить добавку ${option.name}`} disabled={group.options.length === 1} onClick={() => updateGroup(group.id, { options: group.options.filter((o) => o.id !== option.id) })}><Trash2 size={16} /></button></div>
            <details className="option-limits"><summary>Лимиты и цены по размерам</summary><div className="group-limits">{([["min_quantity", "Мин."], ["max_quantity", "Макс."], ["default_quantity", "По умолчанию"]] as const).map(([field, title]) => <label key={field}>{title}<input type="number" min={0} max={20} value={option[field]} onChange={(event) => updateOption(group, option.id, { [field]: Number(event.target.value) })} /></label>)}<label className="switch-label"><input type="checkbox" checked={option.is_available} onChange={(event) => updateOption(group, option.id, { is_available: event.target.checked })} />В наличии</label></div>
              {config.variants.map((variant) => <div className="size-price" key={variant.id}><label className="switch-label"><input type="checkbox" checked={variant.id in option.price_by_variant} onChange={(event) => { const prices = { ...option.price_by_variant }; if (event.target.checked) prices[variant.id] = option.price_minor; else delete prices[variant.id]; updateOption(group, option.id, { price_by_variant: prices }); }} />{variant.name}</label>{variant.id in option.price_by_variant && <label>Доплата, ₽<PriceInput value={option.price_by_variant[variant.id]} onChange={(value) => updateOption(group, option.id, { price_by_variant: { ...option.price_by_variant, [variant.id]: value } })} /></label>}</div>)}
            </details>
          </div>)}
          <button type="button" className="button-quiet" disabled={group.options.length >= 30} onClick={() => updateGroup(group.id, { options: [...group.options, newOption()] })}><Plus size={16} />Добавка</button>
        </section>)}
        <button type="button" className="button-quiet" disabled={config.modifier_groups.length >= 20} onClick={() => updateConfig({ modifier_groups: [...config.modifier_groups, { id: crypto.randomUUID(), name: "Новая группа", min_quantity: 0, max_quantity: 1, options: [newOption()] }] })}><Plus size={16} />Добавить группу</button>
      </div>}
    </div>
    <footer className="dialog-footer"><span className={error ? "form-error" : "muted"}>{error ?? (saving ? "Сохраняем…" : "Автосохранение")}</span><button type="button" onClick={onClose}>Готово</button></footer>
  </Modal>;
}
