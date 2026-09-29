import { ChevronRight, MapPin, Plus } from "lucide-react";
import { useState } from "react";

import type { Restaurant } from "../../../api/restaurants";
import { Button, Sheet } from "../../../design";
import { NewPointForm } from "../shell/NewVenue";
import type { CabinetContext } from "../shell/CabinetShell";
import { PointForm } from "./PointForm";

/**
 * «Заведение и точки» (P1-DOC-15): this point's details, the venue's points and «Новая точка»
 * (≤ 3 steps: name and address → time zone suggested → «Основное» by default) that opens
 * straight on the new point's QR.
 */
export function VenuePage({ context, onOpenPoint, onPointCreated }: {
  context: CabinetContext;
  onOpenPoint: (point: Restaurant) => void;
  onPointCreated: (point: Restaurant) => void;
}) {
  const { point, venuePoints } = context;
  const [adding, setAdding] = useState(false);
  return (
    <div className="more-page">
      <PointForm point={point} />
      <section className="more-block" aria-labelledby="venue-points-title">
        <h2 id="venue-points-title">Точки · {venuePoints.length}</h2>
        <ul className="cabinet-list">
          {venuePoints.map((item) => (
            <li key={item.id}>
              <button type="button" className="cabinet-list__row" aria-current={item.id === point.id || undefined} onClick={() => onOpenPoint(item)} disabled={item.id === point.id}>
                <span className="cabinet-list__icon" aria-hidden="true"><MapPin size={20} /></span>
                <span className="cabinet-list__text"><strong>{item.name}{item.id === point.id ? " · открыта" : ""}</strong><small>{item.address ?? "Адрес не указан"}</small></span>
                {item.id !== point.id && <ChevronRight size={20} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
        <Button variant="secondary" icon={<Plus size={20} />} onClick={() => setAdding(true)}>Новая точка</Button>
      </section>
      <Sheet open={adding} onClose={() => setAdding(false)} title="Новая точка">
        <NewPointForm venueId={point.venue_id} onCreated={(created) => { setAdding(false); onPointCreated(created); }} />
      </Sheet>
    </div>
  );
}
