import { useState } from "react";
import { GuestItemDialog } from "./GuestItemDialog";
import { displayPrice } from "./configuration";
import type { MenuSection, MenuItem } from "../../api/menu";

export function MenuPreview({ sections }: { sections: MenuSection[] }) {
  const [selected, setSelected] = useState<MenuItem | null>(null);
  const visible = sections.map((section) => ({ ...section, items: section.items.filter((item) => item.is_available) })).filter((section) => section.items.length);
  return <div className="menu-preview" aria-label="Предпросмотр меню для гостей">
    {selected && <GuestItemDialog item={selected} onClose={() => setSelected(null)} />}
    {!visible.length && <p className="muted">Добавьте доступные позиции — они появятся здесь.</p>}
    {visible.map((section) => <section key={section.id}>
      <h3>{section.name}</h3>
      {section.items.map((item) => <article className="preview-dish" key={item.id}>
        {item.image_url && <img src={item.image_url} alt={item.name} />}
        <div><strong>{item.name}</strong>{item.description && <p>{item.description}</p>}<small>{item.weight_text}</small></div>
        <button className="button-quiet" onClick={() => setSelected(item)}>{displayPrice(item)}</button>
      </article>)}
    </section>)}
  </div>;
}
