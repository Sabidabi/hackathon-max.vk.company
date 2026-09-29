import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";

import { updateRestaurant, type Restaurant } from "../../../api/restaurants";
import { renameVenue, venueKeys } from "../../../api/venues";
import { Button, Select, Textarea, TextInput } from "../../../design";
import { showToast } from "../../../design/toast";
import { haptics } from "../../../max";
import { TIMEZONES } from "../shell/NewVenue";

/** «Ещё → Заведение и точка»: the venue name and this point's name, address, description and time zone. */
export function PointForm({ point }: { point: Restaurant }) {
  const queryClient = useQueryClient();
  const initial = {
    venue: point.venue_name ?? point.name,
    name: point.name,
    address: point.address ?? "",
    description: point.description ?? "",
    timezone: point.timezone ?? "Europe/Moscow",
  };
  const [values, setValues] = useState(initial);
  const [touched, setTouched] = useState(false);
  const key = JSON.stringify(initial);
  useEffect(() => setValues(JSON.parse(key) as typeof initial), [key]);
  const dirty = JSON.stringify(values) !== key;

  const save = useMutation({
    mutationFn: async () => {
      if (values.venue.trim() !== initial.venue) await renameVenue(point.venue_id, values.venue.trim());
      return updateRestaurant(point.id, {
        name: values.name.trim(),
        address: values.address.trim() || null,
        description: values.description.trim() || null,
        timezone: values.timezone,
      });
    },
    onSuccess: () => {
      haptics.notify("success");
      showToast("Сохранено", { tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["restaurants"] });
      void queryClient.invalidateQueries({ queryKey: venueKeys.venues });
    },
    onError: () => haptics.notify("error"),
  });
  const set = (field: keyof typeof values) => (event: { target: { value: string } }) => setValues((current) => ({ ...current, [field]: event.target.value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (values.venue.trim() && values.name.trim()) save.mutate();
  };
  return (
    <form className="cabinet-card cabinet-form" onSubmit={submit} noValidate>
      <TextInput label="Название заведения" required maxLength={200} value={values.venue} onChange={set("venue")} error={touched && !values.venue.trim() ? "Укажите название заведения" : undefined} hint="Общее для всех точек" />
      <TextInput label="Название точки" required maxLength={200} value={values.name} onChange={set("name")} error={touched && !values.name.trim() ? "Укажите название точки" : undefined} />
      <TextInput label="Адрес" autoComplete="street-address" maxLength={500} placeholder="Город, улица, дом" value={values.address} onChange={set("address")} />
      <Textarea label="Описание" rows={3} maxLength={1000} placeholder="Коротко расскажите гостям о точке" value={values.description} onChange={set("description")} />
      <Select label="Часовой пояс" value={values.timezone} onChange={set("timezone")} hint="По нему меню с часами показа включаются вовремя">
        {TIMEZONES.some(([value]) => value === values.timezone) ? null : <option value={values.timezone}>{values.timezone}</option>}
        {TIMEZONES.map(([value, title]) => <option key={value} value={value}>{title}</option>)}
      </Select>
      {save.isError && <p className="cabinet-error" role="alert">{save.error.message}</p>}
      <Button type="submit" variant="secondary" loading={save.isPending} disabled={!dirty}>Сохранить</Button>
    </form>
  );
}
