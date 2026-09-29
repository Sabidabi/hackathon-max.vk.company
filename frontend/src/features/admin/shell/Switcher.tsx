import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Home, LogOut, MapPin, Plus, Store } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { fetchCurrentUser, logout } from "../../../api/auth";
import type { Restaurant } from "../../../api/restaurants";
import { Button, Sheet } from "../../../design";
import { useMaxLaunch } from "../../../app/MaxLaunchProvider";
import type { CabinetContext } from "./CabinetShell";
import { NewPointForm, NewVenueForm } from "./NewVenue";

interface VenueGroup {
  venueId: string;
  name: string;
  points: Restaurant[];
}

function groupVenues(points: Restaurant[]): VenueGroup[] {
  const groups = new Map<string, VenueGroup>();
  for (const point of points) {
    const key = point.venue_id ?? point.id;
    const group = groups.get(key) ?? { venueId: key, name: point.venue_name ?? point.name, points: [] };
    group.points.push(point);
    groups.set(key, group);
  }
  return [...groups.values()];
}

type Mode = null | "venue" | "point" | "new-venue" | "new-point";

/**
 * «Заведение ▾ / Точка ▾». Picking a point keeps the
 * current section; «Новое заведение» and «Новая точка» live inside the lists.
 */
export function PointSwitcher({ context, onSelect, onCreated, layout }: {
  context: CabinetContext;
  onSelect: (point: Restaurant) => void;
  onCreated: (point: Restaurant) => void;
  layout: "inline" | "stacked";
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [origin, setOrigin] = useState<Element | null>(null);
  const { point, venuePoints, allPoints } = context;
  const venues = groupVenues(allPoints);
  const venueName = point.venue_name ?? point.name;
  const close = () => setMode(null);
  const open = (next: Mode) => (event: { currentTarget: Element }) => {
    setOrigin(event.currentTarget);
    setMode(next);
  };

  const pick = (target: Restaurant) => {
    close();
    if (target.id !== point.id) onSelect(target);
  };

  return (
    <div className={`cabinet-switcher cabinet-switcher--${layout}`}>
      <button type="button" className="cabinet-switcher__button" aria-haspopup="dialog" aria-label={`Заведение: ${venueName}. Сменить`} onClick={open("venue")}>
        <Store size={18} aria-hidden="true" />
        <span className="cabinet-switcher__text">{venueName}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <button type="button" className="cabinet-switcher__button cabinet-switcher__button--point" aria-haspopup="dialog" aria-label={`Точка: ${point.name}. Сменить`} onClick={open("point")}>
        <MapPin size={18} aria-hidden="true" />
        <span className="cabinet-switcher__text">{point.name}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>

      <Sheet open={mode === "venue"} onClose={close} title="Заведение" origin={origin}>
        <ul className="cabinet-choice" aria-label="Ваши заведения">
          {venues.map((venue) => {
            const current = venue.venueId === point.venue_id;
            return (
              <li key={venue.venueId}>
                <button type="button" className="cabinet-choice__item" aria-current={current || undefined} onClick={() => pick(current ? point : venue.points[0])}>
                  <span className="cabinet-choice__text"><strong>{venue.name}</strong><small>{venue.points.length === 1 ? "1 точка" : `Точек: ${venue.points.length}`}</small></span>
                  {current && <Check size={20} aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
        <Button variant="ghost" icon={<Plus size={20} />} fullWidth onClick={() => setMode("new-venue")}>Новое заведение</Button>
      </Sheet>

      <Sheet open={mode === "point"} onClose={close} title={`Точки «${venueName}»`} origin={origin}>
        <ul className="cabinet-choice" aria-label="Точки заведения">
          {venuePoints.map((item) => (
            <li key={item.id}>
              <button type="button" className="cabinet-choice__item" aria-current={item.id === point.id || undefined} onClick={() => pick(item)}>
                <span className="cabinet-choice__text"><strong>{item.name}</strong><small>{item.address || "Адрес не указан"}</small></span>
                {item.id === point.id && <Check size={20} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
        <Button variant="ghost" icon={<Plus size={20} />} fullWidth onClick={() => setMode("new-point")}>Новая точка</Button>
      </Sheet>

      <Sheet open={mode === "new-venue"} onClose={close} title="Новое заведение">
        <NewVenueForm onCreated={(created) => { close(); onCreated(created); }} />
      </Sheet>

      <Sheet open={mode === "new-point"} onClose={close} title="Новая точка">
        <NewPointForm venueId={point.venue_id} onCreated={(created) => { close(); onCreated(created); }} />
      </Sheet>
    </div>
  );
}

function initials(name: string | undefined): string {
  const parts = (name ?? "").replace(/[·•].*$/, "").trim().split(/\s+/).filter(Boolean);
  return (parts.slice(0, 2).map((part) => part[0]).join("") || "?").toUpperCase();
}

/** Avatar with the account: the signed-in name, the way home and «Выйти». */
export function AccountButton({ withName }: { withName?: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { context: max } = useMaxLaunch();
  const user = useQuery({ queryKey: ["current-user"], queryFn: fetchCurrentUser, staleTime: Infinity, retry: false }).data;
  const [open, setOpen] = useState(false);
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.clear();
      queryClient.setQueryData(["current-user"], null);
    },
  });
  return (
    <>
      <button type="button" className={["cabinet-account", withName && "cabinet-account--named"].filter(Boolean).join(" ")} aria-haspopup="dialog" aria-label={`Аккаунт: ${user?.display_name ?? ""}`} onClick={() => setOpen(true)}>
        <span className="cabinet-account__avatar" aria-hidden="true">{initials(user?.display_name)}</span>
        {withName && <span className="cabinet-account__name">{user?.display_name}</span>}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={user?.display_name ?? "Аккаунт"}>
        <div className="cabinet-stack">
          <Button variant="secondary" icon={<Home size={20} />} fullWidth onClick={() => { setOpen(false); navigate(max.available ? "/home" : "/"); }}>На главную</Button>
          <Button variant="secondary" icon={<LogOut size={20} />} fullWidth loading={signOut.isPending} onClick={() => signOut.mutate()}>Выйти</Button>
          {signOut.isError && <p className="cabinet-error" role="alert">Не удалось выйти. Попробуйте ещё раз.</p>}
        </div>
      </Sheet>
    </>
  );
}
