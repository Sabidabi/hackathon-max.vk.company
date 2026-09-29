import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Store } from "lucide-react";
import { useState, type FormEvent } from "react";

import { trackAdmin } from "../../../analytics";
import { createRestaurant, type Restaurant } from "../../../api/restaurants";
import { createPoint, listVenueMenus, setMenuOnPoint, venueKeys } from "../../../api/venues";
import { BrandLockup, Button, Select, TextInput } from "../../../design";
import { haptics } from "../../../max";

/** Time zones offered for a point (IANA; the server validates). Moscow by default. */
export const TIMEZONES: Array<[string, string]> = [
  ["Europe/Kaliningrad", "Калининград (МСК−1)"],
  ["Europe/Moscow", "Москва (МСК)"],
  ["Europe/Samara", "Самара (МСК+1)"],
  ["Asia/Yekaterinburg", "Екатеринбург (МСК+2)"],
  ["Asia/Omsk", "Омск (МСК+3)"],
  ["Asia/Novosibirsk", "Новосибирск (МСК+4)"],
  ["Asia/Krasnoyarsk", "Красноярск (МСК+4)"],
  ["Asia/Irkutsk", "Иркутск (МСК+5)"],
  ["Asia/Yakutsk", "Якутск (МСК+6)"],
  ["Asia/Vladivostok", "Владивосток (МСК+7)"],
  ["Asia/Magadan", "Магадан (МСК+8)"],
  ["Asia/Kamchatka", "Камчатка (МСК+9)"],
];

/** A city in the address suggests its time zone. */
export function guessTimezone(address: string): string | null {
  const text = address.toLocaleLowerCase("ru");
  const hints: Array<[RegExp, string]> = [
    [/калининград/, "Europe/Kaliningrad"],
    [/самар|ижевск|ульяновск/, "Europe/Samara"],
    [/екатеринбург|челябинск|тюмень|пермь|уфа/, "Asia/Yekaterinburg"],
    [/омск/, "Asia/Omsk"],
    [/новосибирск|томск|барнаул/, "Asia/Novosibirsk"],
    [/красноярск|кемерово|новокузнецк/, "Asia/Krasnoyarsk"],
    [/иркутск|улан-удэ/, "Asia/Irkutsk"],
    [/якутск|чита/, "Asia/Yakutsk"],
    [/владивосток|хабаровск/, "Asia/Vladivostok"],
    [/магадан|сахалин/, "Asia/Magadan"],
    [/камчат/, "Asia/Kamchatka"],
    [/москв|петербург|казан|нижн|ростов|воронеж|краснодар|сочи/, "Europe/Moscow"],
  ];
  return hints.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function useRestaurantsRefresh() {
  const queryClient = useQueryClient();
  return (created: Restaurant) => {
    queryClient.setQueryData<Restaurant[]>(["restaurants"], (current = []) => [...current.filter((item) => item.id !== created.id), created]);
    void queryClient.invalidateQueries({ queryKey: ["restaurants"] });
    void queryClient.invalidateQueries({ queryKey: venueKeys.venues });
  };
}

/** «Новое заведение»: a name (and, optionally, an address) — the venue gets its first point and «Основное» menu. */
export function NewVenueForm({ onCreated }: { onCreated: (point: Restaurant) => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [touched, setTouched] = useState(false);
  const refresh = useRestaurantsRefresh();
  const create = useMutation({
    mutationFn: () => createRestaurant({ name: name.trim(), address: address.trim() || null, description: null }),
    onSuccess: (created) => {
      haptics.notify("success");
      trackAdmin("venue_created", {}, created.public_id);
      refresh(created);
      onCreated(created);
    },
    onError: () => haptics.notify("error"),
  });
  const nameError = touched && !name.trim() ? "Укажите название" : undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (name.trim()) create.mutate();
  };
  return (
    <form className="cabinet-form" onSubmit={submit} noValidate>
      <TextInput label="Название" required placeholder="Например, Кофейня Север" autoComplete="organization" maxLength={200} value={name} onChange={(event) => setName(event.target.value)} error={nameError} data-autofocus />
      <TextInput label="Адрес" placeholder="Город, улица, дом" autoComplete="street-address" maxLength={500} value={address} onChange={(event) => setAddress(event.target.value)} hint="Можно добавить позже" />
      {create.isError && <p className="cabinet-error" role="alert">{create.error.message}</p>}
      <Button type="submit" fullWidth loading={create.isPending}>Создать заведение</Button>
    </form>
  );
}

/** The very first screen of an admin without venues. */
export function NewVenue({ onCreated }: { onCreated: (point: Restaurant) => void; first?: boolean }) {
  return (
    <main className="cabinet cabinet--centered">
      <section className="cabinet-onboarding" aria-labelledby="new-venue-title">
        <BrandLockup width={160} />
        <span className="cabinet-onboarding__icon" aria-hidden="true"><Store size={28} /></span>
        <h1 id="new-venue-title">Новое заведение</h1>
        <p className="cabinet-muted">Начнём с названия — остальное можно заполнить потом.</p>
        <NewVenueForm onCreated={onCreated} />
      </section>
    </main>
  );
}

/**
 * «Новая точка» in ≤ 3 steps: address and time zone (suggested by the city),
 * a menu from the library («Основное» by default) → the point with its own QR.
 */
export function NewPointForm({ venueId, onCreated }: { venueId: string; onCreated: (point: Restaurant) => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [timezone, setTimezone] = useState("Europe/Moscow");
  const [zoneTouched, setZoneTouched] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const refresh = useRestaurantsRefresh();
  const menus = useQuery({ queryKey: venueKeys.menus(venueId), queryFn: () => listVenueMenus(venueId) });
  const chosenMenu = menuId ?? menus.data?.[0]?.id ?? "";
  const create = useMutation({
    mutationFn: async () => {
      const point = await createPoint(venueId, { name: name.trim(), address: address.trim() || null, timezone });
      if (chosenMenu) await setMenuOnPoint(point.id, chosenMenu, true);
      return { ...point, menu_id: chosenMenu || null };
    },
    onSuccess: (created) => {
      haptics.notify("success");
      refresh(created);
      onCreated(created);
    },
    onError: () => haptics.notify("error"),
  });
  const nameError = touched && !name.trim() ? "Укажите название точки" : undefined;
  return (
    <form
      className="cabinet-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (name.trim()) create.mutate();
      }}
    >
      <TextInput label="Название" required placeholder="Например, Тверская" maxLength={200} value={name} onChange={(event) => setName(event.target.value)} error={nameError} data-autofocus />
      <TextInput
        label="Адрес"
        placeholder="Город, улица, дом"
        autoComplete="street-address"
        maxLength={500}
        value={address}
        onChange={(event) => {
          setAddress(event.target.value);
          const guess = guessTimezone(event.target.value);
          if (guess && !zoneTouched) setTimezone(guess);
        }}
      />
      <Select label="Часовой пояс" value={timezone} onChange={(event) => { setZoneTouched(true); setTimezone(event.target.value); }} hint="По нему меню с часами показа включаются вовремя">
        {TIMEZONES.map(([value, title]) => <option key={value} value={value}>{title}</option>)}
      </Select>
      <Select label="Меню точки" value={chosenMenu} onChange={(event) => setMenuId(event.target.value)} disabled={menus.isPending}>
        {menus.data?.map((menu) => <option key={menu.id} value={menu.id}>{menu.title}</option>)}
        <option value="">Без меню — назначу позже</option>
      </Select>
      {create.isError && <p className="cabinet-error" role="alert">{create.error.message}</p>}
      {/* Until the library loads the default menu is unknown: a point would be created without one. */}
      <Button type="submit" fullWidth loading={create.isPending} disabled={menus.isPending}>Создать точку</Button>
    </form>
  );
}
