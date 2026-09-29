import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Minus, Pencil, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { emptyConfiguration, quoteMenuItem, type MenuItem } from "../../api/menu";
import { Modal } from "../../components/Modal";

function formatPrice(minor: number): string {
  return `${(minor / 100).toLocaleString("ru-RU")} ₽`;
}

export function GuestItemDialog({ item, publicId, onClose, editPath }: {
  item: MenuItem;
  publicId?: string;
  onClose: () => void;
  /** Cabinet link for an admin of this venue. */
  editPath?: string;
}) {
  const config = item.configuration ?? emptyConfiguration();
  const [variantId, setVariantId] = useState(
    config.variants.find((variant) => variant.id === config.default_variant_id && variant.is_available)?.id
      ?? config.variants.find((variant) => variant.is_available)?.id
      ?? null,
  );
  const [quantities, setQuantities] = useState<Record<string, number>>(() => Object.fromEntries(
    config.modifier_groups.flatMap((group) => group.options.map((option) => [option.id, option.default_quantity])),
  ));
  const modifiers = useMemo(
    () => Object.entries(quantities).filter(([, quantity]) => quantity > 0).map(([option_id, quantity]) => ({ option_id, quantity })),
    [quantities],
  );
  const incomplete = config.modifier_groups.some((group) => {
    const count = group.options.reduce((sum, option) => sum + (quantities[option.id] ?? 0), 0);
    return count < group.min_quantity
      || count > group.max_quantity
      || group.options.some((option) => (quantities[option.id] ?? 0) < option.min_quantity
        || (quantities[option.id] ?? 0) > option.max_quantity);
  });
  const quote = useQuery({
    queryKey: ["menu-quote", publicId, item.id, variantId, modifiers],
    queryFn: ({ signal }) => quoteMenuItem(publicId!, item.id, variantId, modifiers, signal),
    enabled: Boolean(publicId) && !incomplete,
    retry: false,
  });
  const previewPrice = (config.variants.find((variant) => variant.id === variantId)?.price_minor ?? item.price_minor)
    + config.modifier_groups.reduce((total, group) => total + group.options.reduce((sum, option) => {
      const price = variantId && option.price_by_variant[variantId] !== undefined
        ? option.price_by_variant[variantId]
        : option.price_minor;
      return sum + (quantities[option.id] ?? 0) * price;
    }, 0), 0);
  const amount = publicId ? quote.data?.unit_price_minor : incomplete ? undefined : previewPrice;

  return <Modal
    title={item.name}
    onClose={onClose}
    className="guest-item-dialog"
    cover={item.image_url ? <img className="guest-item-photo" src={item.image_url} alt="" /> : undefined}
  >
    <div className="dialog-body guest-configuration">
      {(item.description || item.weight_text) && <div className="guest-item-intro">
        {item.description && <p>{item.description}</p>}
        {item.weight_text && <small>{item.weight_text}</small>}
      </div>}

      {!!config.variants.length && <fieldset className="guest-options">
        <legend>Размер</legend>
        <div className="guest-size-grid">
          {config.variants.map((variant) => <label className="guest-size-choice" key={variant.id}>
            <input
              type="radio"
              name="guest-size"
              value={variant.id}
              checked={variantId === variant.id}
              disabled={!variant.is_available}
              onChange={() => setVariantId(variant.id)}
            />
            <span>{variant.name}{!variant.is_available && <small>Нет в наличии</small>}</span>
            <strong>{formatPrice(variant.price_minor)}</strong>
          </label>)}
        </div>
      </fieldset>}

      {config.modifier_groups.map((group) => {
        const count = group.options.reduce((sum, option) => sum + (quantities[option.id] ?? 0), 0);
        const singleChoice = group.max_quantity === 1;
        const requiredOption = group.options.find((option) => option.min_quantity > 0);
        return <fieldset className="guest-options" key={group.id}>
          <legend><span>{group.name}</span><small>{group.min_quantity
            ? `Обязательно · ${group.min_quantity === group.max_quantity ? group.min_quantity : `${group.min_quantity}–${group.max_quantity}`}`
            : `До ${group.max_quantity}`}</small></legend>
          <div className="guest-option-list">
            {singleChoice && group.min_quantity === 0 && !requiredOption && <label className="guest-option-choice">
              <span>Без добавки</span>
              <input
                type="radio"
                name={`guest-group-${group.id}`}
                checked={count === 0}
                onChange={() => setQuantities((current) => ({
                  ...current,
                  ...Object.fromEntries(group.options.map((option) => [option.id, 0])),
                }))}
              />
            </label>}
            {group.options.map((option) => {
              const value = quantities[option.id] ?? 0;
              const price = variantId && option.price_by_variant[variantId] !== undefined
                ? option.price_by_variant[variantId]
                : option.price_minor;
              return singleChoice
                ? <label className="guest-option-choice" key={option.id}>
                  <span>{option.name}{!option.is_available && <small>Нет в наличии</small>}</span>
                  <strong>{price ? `+${formatPrice(price)}` : "Без доплаты"}</strong>
                  <input
                    type="radio"
                    name={`guest-group-${group.id}`}
                    checked={value > 0}
                    disabled={!option.is_available || option.max_quantity === 0 || Boolean(requiredOption && requiredOption.id !== option.id)}
                    onChange={() => setQuantities((current) => ({
                      ...current,
                      ...Object.fromEntries(group.options.map((choice) => [choice.id, choice.id === option.id ? 1 : 0])),
                    }))}
                  />
                </label>
                : <div className="guest-option-choice guest-option-choice--stepper" key={option.id}>
                  <span>{option.name}{!option.is_available && <small>Нет в наличии</small>}</span>
                  <strong>{price ? `+${formatPrice(price)}` : "Без доплаты"}</strong>
                  <div className="quantity-stepper">
                    <button type="button" className="icon-button" aria-label={`Уменьшить ${option.name}`} disabled={value <= option.min_quantity} onClick={() => setQuantities({ ...quantities, [option.id]: value - 1 })}><Minus size={16} /></button>
                    <span>{value}</span>
                    <button type="button" className="icon-button" aria-label={`Добавить ${option.name}`} disabled={!option.is_available || value >= option.max_quantity || count >= group.max_quantity} onClick={() => setQuantities({ ...quantities, [option.id]: value + 1 })}><Plus size={16} /></button>
                  </div>
                </div>;
            })}
          </div>
        </fieldset>;
      })}
      {publicId && quote.isError && <p className="form-error" role="alert">{quote.error.message}</p>}
    </div>
    <footer className="dialog-footer guest-dialog-footer">
      <div><small>Цена за порцию</small><strong className="quoted-price" aria-live="polite">{amount !== undefined
        ? formatPrice(amount)
        : publicId && quote.isPending ? "Считаем…" : "Выберите добавки"}</strong></div>
      {editPath && <Link className="guest-edit-link" to={editPath}><Pencil size={17} aria-hidden="true" />Редактировать</Link>}
      <button type="button" onClick={onClose}>Готово</button>
    </footer>
  </Modal>;
}
