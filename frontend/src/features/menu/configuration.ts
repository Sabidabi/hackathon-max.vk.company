import type { ItemConfiguration, MenuItem } from "../../api/menu";
export function configurationError(config: ItemConfiguration): string | null {
  const money = (value: number) => Number.isInteger(value) && value >= 0 && value <= 100_000_000;
  const quantity = (value: number) => Number.isInteger(value) && value >= 0 && value <= 20;
  for (const variant of config.variants) if (!variant.name.trim() || !money(variant.price_minor)) return "Проверьте название и цену размера";
  for (const group of config.modifier_groups) {
    if (!group.name.trim() || !group.options.length || !quantity(group.min_quantity) || !quantity(group.max_quantity) || group.min_quantity > group.max_quantity) return "Проверьте название и лимиты группы";
    let minimum = 0, maximum = 0, defaults = 0;
    for (const option of group.options) {
      if (!option.name.trim() || !money(option.price_minor) || !Object.values(option.price_by_variant).every(money)) return "Проверьте название и цену добавки";
      if (![option.min_quantity, option.max_quantity, option.default_quantity].every(quantity) || option.min_quantity > option.default_quantity || option.default_quantity > option.max_quantity) return "Добавка: минимум ≤ по умолчанию ≤ максимум";
      minimum += option.min_quantity; maximum += option.max_quantity; defaults += option.default_quantity;
    }
    if (Math.max(group.min_quantity, minimum) > Math.min(group.max_quantity, maximum) || defaults > group.max_quantity) return "Лимиты группы противоречат настройкам добавок";
  }
  return null;
}
export function displayPrice(item: MenuItem): string {
  const prices = item.configuration?.variants.filter((variant) => variant.is_available).map((variant) => variant.price_minor) ?? [];
  const amount = prices.length ? Math.min(...prices) : item.price_minor;
  return `${prices.length > 1 ? "от " : ""}${(amount / 100).toLocaleString("ru-RU")} ₽`;
}
