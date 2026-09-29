import { Clock3, MapPin } from "lucide-react";
import { useMemo, type CSSProperties } from "react";

import type { MenuItem, MenuSection } from "../../../api/menu";
import type { SiteConfig } from "../../../api/site";
import { themeVariables } from "../../guest/theme";
import "../../guest/guest.css";
import { displayPrice } from "../../menu/configuration";

const SAMPLE: MenuSection[] = [
  {
    id: "sample-coffee",
    name: "Кофе",
    items: [
      { name: "Капучино", price_minor: 19000, weight_text: "300 мл", description: "Эспрессо и молочная пена" },
      { name: "Латте", price_minor: 21000, weight_text: "400 мл", description: null },
      { name: "Флэт уайт", price_minor: 22000, weight_text: "200 мл", description: null },
    ].map((item, index) => ({ id: `sample-${index}`, item_key: null, currency: "RUB", image_url: null, ingredients: null, allergens: [], is_available: true, source_confidence: null, configuration: undefined, ...item })) as unknown as MenuItem[],
  },
];

/**
 * «Глазами гостя»: the draft theme on the classes of the new guest menu
 * (`features/guest/guest.css`, only imported) with the same colour mapping (`themeVariables`).
 * The variables live on this frame only — the cabinet keeps the «Синица» palette.
 */
export function ThemePreview({ config, title, address, sections }: {
  config: SiteConfig;
  title: string;
  address: string | null;
  sections: MenuSection[];
}) {
  const style = useMemo(() => {
    const { "color-scheme": colorScheme, ...custom } = themeVariables(config as never);
    return { ...custom, colorScheme, fontSize: `${config.font_scale * 100}%` } as CSSProperties;
  }, [config]);
  const shown = (sections.some((section) => section.items.length) ? sections : SAMPLE)
    .filter((section) => section.items.length)
    .slice(0, 2)
    .map((section) => ({ ...section, items: section.items.slice(0, 4) }));
  const coverStyle = config.cover_url ? ({ "--g-cover": `url("${config.cover_url.replace(/"/g, "%22")}")` } as CSSProperties) : undefined;
  return (
    <div className="design-phone" aria-label="Предпросмотр: так увидит гость">
      <div className={`g-root design-phone__screen g-template--${config.template}`} style={style} inert>
        <header className={`g-cover${config.cover_url ? " g-cover--image" : ""}`} style={coverStyle}>
          <div className="g-cover__row">
            {config.logo_url && <img className="g-cover__logo" src={config.logo_url} alt="" width={48} height={48} />}
            <div className="g-cover__text"><h1 className="g-cover__title">{title}</h1></div>
          </div>
          {(address || config.hours) && (
            <p className="g-cover__meta">
              {address && <span><MapPin size={14} aria-hidden="true" />{address}</span>}
              {config.hours && <span><Clock3 size={14} aria-hidden="true" />{config.hours}</span>}
            </p>
          )}
          {config.tagline && <p className="g-cover__tagline">{config.tagline}</p>}
        </header>
        <main className="g-main">
          {shown.map((section) => (
            <section key={section.id} className="g-section">
              <div className="g-section__head"><h2>{section.name}</h2></div>
              <div className="g-rows">
                {section.items.map((item) => (
                  <article key={item.id} className={`g-card g-card--row${item.is_available ? "" : " g-card--off"}`}>
                    <span className="g-card__open">
                      <span className="g-card__body">
                        <span className="g-card__line">
                          <span className="g-card__name">{item.name}</span>
                          {item.is_available && <b className="g-card__price">{item.price_minor || item.configuration?.variants.length ? displayPrice(item) : "—"}</b>}
                        </span>
                        {item.description && <span className="g-card__desc">{item.description}</span>}
                      </span>
                    </span>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </main>
      </div>
    </div>
  );
}
