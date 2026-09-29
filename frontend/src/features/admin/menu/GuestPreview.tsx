import type { MenuItem, MenuSection } from "../../../api/menu";
import { displayPrice } from "../../menu/configuration";
import { hasPrice } from "./MenuStart";

const price = (item: MenuItem) => (hasPrice(item) ? displayPrice(item) : "Нет цены");

/**
 * «Как увидит гость» (P1-DOC-17): the draft laid out by the guest-menu rule of P1-DOC-6
 * ([decision] 29.09) — a position with a photo is a tile (two per row), one without a photo is
 * a row; a mixed section shows the tiles first, then the rows; no invented pictures. Colours
 * are neutral: the venue theme is applied in the real guest menu and in «Оформление».
 */
export function GuestPreview({ title, sections, available }: {
  title: string;
  sections: MenuSection[];
  /** Availability at the current point (stop-list), by item. */
  available: (item: MenuItem) => boolean;
}) {
  const visible = sections.filter((section) => section.items.length);
  return (
    <div className="guest-preview" aria-label="Предпросмотр меню для гостей">
      <p className="guest-preview__venue">{title}</p>
      {!visible.length && <p className="guest-preview__empty">Меню скоро появится</p>}
      {visible.map((section) => {
        const tiles = section.items.filter((item) => item.image_url);
        const rows = section.items.filter((item) => !item.image_url);
        return (
          <section key={section.id} className="guest-preview__section">
            <h3>{section.name}</h3>
            {tiles.length > 0 && (
              <div className="guest-preview__tiles">
                {tiles.map((item) => (
                  <article key={item.id} className={["guest-preview__tile", !available(item) && "guest-preview--off"].filter(Boolean).join(" ")}>
                    <img src={item.image_url!} alt="" loading="lazy" />
                    <strong>{item.name}</strong>
                    <span>{available(item) ? price(item) : "Нет в наличии"}</span>
                  </article>
                ))}
              </div>
            )}
            {rows.length > 0 && (
              <ul className="guest-preview__rows">
                {rows.map((item) => (
                  <li key={item.id} className={available(item) ? undefined : "guest-preview--off"}>
                    <span className="guest-preview__row-text">
                      <strong>{item.name}</strong>
                      {item.description && <small>{item.description}</small>}
                    </span>
                    <span className="guest-preview__price">{available(item) ? price(item) : "Нет в наличии"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
