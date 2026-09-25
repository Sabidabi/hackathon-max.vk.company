import { ChevronRight } from "lucide-react";
import { useState } from "react";

import type { MenuItem, MenuSection } from "../../api/menu";
import { GuestItemDialog } from "./GuestItemDialog";
import { displayPrice } from "./configuration";

export function MenuPreview({ sections }: { sections: MenuSection[] }) {
  const [selected, setSelected] = useState<MenuItem | null>(null);
  const visible = sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => item.is_available),
    }))
    .filter((section) => section.items.length);

  return (
    <div className="menu-preview mobile-menu-catalog menu-preview--cards" aria-label="Предпросмотр меню для гостей">
      {selected && <GuestItemDialog item={selected} onClose={() => setSelected(null)} />}
      {!visible.length && <p className="muted">Добавьте доступные позиции — они появятся здесь.</p>}
      <div className="public-sections">
        {visible.map((section) => (
          <section key={section.id}>
            <header className="menu-section-heading"><h2>{section.name}</h2><span>{section.items.length}</span></header>
            <div className={`public-items${section.items.every((item) => !item.image_url) ? " public-items--text-only" : ""}`}>
              {section.items.map((item, itemIndex) => (
                <article key={item.id}>
                  <button type="button" className={`menu-card-button menu-card-tone--${itemIndex % 4}${item.image_url ? "" : " menu-card-button--no-image"}`} aria-label={`Открыть ${item.name}`} onClick={() => setSelected(item)}>
                    {item.image_url && <span className="menu-card-media"><img src={item.image_url} alt={item.name} /></span>}
                    <span className="menu-card-content">
                      <strong>{item.name}</strong>
                      {item.description && <span className="menu-card-description">{item.description}</span>}
                      <span className="menu-card-footer"><b>{displayPrice(item)}</b><span aria-hidden="true"><ChevronRight size={16} /></span></span>
                    </span>
                  </button>
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
