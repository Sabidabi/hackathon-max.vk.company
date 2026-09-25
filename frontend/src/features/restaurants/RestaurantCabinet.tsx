import { Store, Utensils, Palette, QrCode, Upload, Bell, Plus, Copy, Users } from "lucide-react";
import { Help } from "../../components/Help";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import {
  createRestaurant,
  listRestaurants,
  type Restaurant,
  type RestaurantPayload,
  updateRestaurant,
} from "../../api/restaurants";
import { MenuUpload } from "../imports/MenuUpload";
import { DraftEditor } from "../menu/DraftEditor";
import { MenuShare } from "../menu/MenuShare";
import { SiteBuilder } from "../site/SiteBuilder";
import { NotificationCenter } from "../notifications/NotificationCenter";
import { TeamPanel } from "./TeamPanel";

const restaurantSchema = z.object({
  name: z.string().trim().min(1, "Укажите название").max(200, "Не более 200 символов"),
  address: z.string().max(500, "Не более 500 символов"),
  description: z.string().max(1000, "Не более 1000 символов"),
});

type RestaurantFormValues = z.infer<typeof restaurantSchema>;

function toPayload(values: RestaurantFormValues): RestaurantPayload {
  return {
    name: values.name.trim(),
    address: values.address.trim() || null,
    description: values.description.trim() || null,
  };
}

function RestaurantForm({ restaurant, onCreated }: { restaurant?: Restaurant; onCreated?: (restaurant: Restaurant) => void }) {
  const queryClient = useQueryClient();
  const isEditing = Boolean(restaurant);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<RestaurantFormValues>({
    resolver: zodResolver(restaurantSchema),
    defaultValues: {
      name: restaurant?.name ?? "",
      address: restaurant?.address ?? "",
      description: restaurant?.description ?? "",
    },
  });

  useEffect(() => {
    if (restaurant && !isDirty) {
      reset({
        name: restaurant.name,
        address: restaurant.address ?? "",
        description: restaurant.description ?? "",
      });
    }
  }, [restaurant, reset, isDirty]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (isDirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [isDirty]);

  const saveRestaurant = useMutation({
    mutationFn: (values: RestaurantFormValues) =>
      restaurant
        ? updateRestaurant(restaurant.id, toPayload(values))
        : createRestaurant(toPayload(values)),
    onError: () => { if (!restaurant) void queryClient.invalidateQueries({ queryKey: ["restaurants"] }); },
    onSuccess: (savedRestaurant) => {
      queryClient.setQueryData<Restaurant[]>(["restaurants"], (current = []) =>
        current.some((item) => item.id === savedRestaurant.id)
          ? current.map((item) => item.id === savedRestaurant.id ? savedRestaurant : item)
          : [...current, savedRestaurant]);
      if (!restaurant) onCreated?.(savedRestaurant);
      reset({
        name: savedRestaurant.name,
        address: savedRestaurant.address ?? "",
        description: savedRestaurant.description ?? "",
      });
    },
  });

  return (
    <form className="restaurant-form" onSubmit={handleSubmit((values) => saveRestaurant.mutate(values))}>
      <fieldset className="editor-fields" disabled={saveRestaurant.isPending || Boolean(restaurant && !["owner", "manager"].includes(restaurant.role))}>
      <label>
        <span>Название</span>
        <input placeholder="Например, Север" autoComplete="organization" {...register("name")} />
        {errors.name && <small className="field-error">{errors.name.message}</small>}
      </label>

      <label>
        <span>Адрес</span>
        <input placeholder="Город, улица, дом" autoComplete="street-address" {...register("address")} />
        {errors.address && <small className="field-error">{errors.address.message}</small>}
      </label>

      <label>
        <span>Описание</span>
        <textarea
          rows={4}
          placeholder="Коротко расскажите гостям о ресторане"
          {...register("description")}
        />
        {errors.description && <small className="field-error">{errors.description.message}</small>}
      </label>

      </fieldset>
      {saveRestaurant.isError && (
        <p className="form-error" role="alert">
          {saveRestaurant.error.message}
        </p>
      )}
      {saveRestaurant.isSuccess && !isDirty && (
        <p className="form-success">Сохранено</p>
      )}

      <button type="submit" disabled={saveRestaurant.isPending || (isEditing && !isDirty) || Boolean(restaurant && !["owner", "manager"].includes(restaurant.role))}>
        {saveRestaurant.isPending
          ? "Сохраняем…"
          : isEditing
            ? "Сохранить"
            : "Создать точку"}
      </button>
    </form>
  );
}

export function RestaurantCabinet({ initialPoint = null }: { initialPoint?: string | null }) {
  const [step, setStep] = useState("menu");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [menuUnsaved, setMenuUnsaved] = useState(false);
  const restaurants = useQuery({
    queryKey: ["restaurants"],
    queryFn: listRestaurants,
    retry: false,
  });

  if (restaurants.isPending) {
    return <section className="cabinet-card cabinet-card--loading">Загружаем кабинет…</section>;
  }

  if (restaurants.isError) {
    return (
      <section className="cabinet-card">
        <h2>Не удалось открыть кабинет</h2>
        <p className="muted">{restaurants.error.message}</p>
        <button type="button" onClick={() => restaurants.refetch()}>
          Повторить
        </button>
      </section>
    );
  }

  const restaurant = restaurants.data.find((item) => item.id === selectedId) ?? restaurants.data[0];

  if (!restaurant) return <section className="onboarding-card" id="restaurant-cabinet"><span className="onboarding-icon"><Store size={28} /></span><h2>Новая точка</h2><p className="muted">Начнём с названия и адреса.</p><RestaurantForm onCreated={(created) => { setSelectedId(created.id); setStep("menu"); }} /></section>;
  const selected = restaurants.data.find((item) => item.public_id === initialPoint && item.id === selectedId)
    ?? restaurants.data.find((item) => item.id === selectedId)
    ?? restaurants.data.find((item) => item.public_id === initialPoint)
    ?? restaurant;
  const navigation = [ { id: "menu", label: "Меню", Icon: Utensils }, { id: "profile", label: "Точка", Icon: Store }, { id: "design", label: "Оформление", Icon: Palette }, { id: "share", label: "QR-код", Icon: QrCode }, ...(selected.role === "owner" ? [{ id: "team", label: "Команда", Icon: Users }] : []), ...(["owner", "manager"].includes(selected.role) ? [{ id: "notifications", label: "Рассылки", Icon: Bell }] : []) ];
  return <div className="cabinet-layout" id="restaurant-cabinet" key={selected.id}>
    <aside className="cabinet-sidebar"><div className="venue-switch"><span className="venue-icon"><Store size={20} /></span><div><strong>{selected.name}</strong><small>{selected.address || "Адрес не указан"}</small></div></div>
      <div className="venue-controls"><select aria-label="Выбрать точку" value={selected.id} onChange={(event) => { if (menuUnsaved) { window.alert("Дождитесь сохранения меню."); return; } const next = restaurants.data.find((item) => item.id === event.target.value); if (next) { setSelectedId(next.id); window.history.replaceState(null, "", `/manage/${next.public_id}`); setStep("menu"); } }}>{restaurants.data.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button type="button" className="venue-add-button" onClick={() => { if (menuUnsaved) window.alert("Дождитесь сохранения меню."); else setStep("create"); }}><Plus size={16} />Новая точка</button></div>
      <nav className="cabinet-steps" aria-label="Кабинет">{navigation.map(({ id, label, Icon }) => <button type="button" key={id} aria-current={step === id ? "page" : undefined} onClick={() => setStep(id)}><Icon size={19} /><span>{label}</span></button>)}</nav>
      <div className="sidebar-status"><span className={`status-dot ${selected.current_published_version_id ? "is-live" : ""}`} />{selected.current_published_version_id ? "Меню опубликовано" : "Черновик"}</div>
    </aside>
    <div className="cabinet-content">
      <div hidden={step !== "create"}><div className="workspace-title"><h2>Новая точка</h2></div><div className="profile-card"><RestaurantForm onCreated={(created) => { setSelectedId(created.id); window.history.replaceState(null, "", `/manage/${created.public_id}`); setStep("menu"); }} /></div></div>
      <div hidden={step !== "profile"}><div className="workspace-title"><h2>Точка</h2><Help label="О данных точки">Название, адрес и описание обновляются для гостей после сохранения. Часы работы и контакты находятся в оформлении.</Help></div><div className="profile-card"><RestaurantForm restaurant={selected} /><button type="button" className="button-quiet" onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}/manage/${selected.public_id}`).then(() => setCopied(true)); }}><Copy size={15} />{copied ? "Ссылка скопирована" : "Ссылка на кабинет"}</button></div></div>
      <div hidden={step !== "menu"}><DraftEditor restaurantId={selected.id} publicId={selected.public_id} isPublished={Boolean(selected.current_published_version_id)} canPublish={["owner", "manager"].includes(selected.role)} isOwner={selected.role === "owner"} points={restaurants.data} onUnsavedChange={setMenuUnsaved} /><details className="import-disclosure"><summary><Upload size={16} />Импорт PDF / фото</summary><MenuUpload restaurantId={selected.id} /></details></div>
      <div hidden={step !== "design"}><SiteBuilder restaurant={selected} /></div>
      <div hidden={step !== "share"}><MenuShare restaurantId={selected.id} published={Boolean(selected.current_published_version_id)} /></div>
      <div hidden={step !== "team"}>{selected.role === "owner" && <TeamPanel restaurantId={selected.id} />}</div>
      <div hidden={step !== "notifications"}><NotificationCenter restaurantId={selected.id} /></div>
    </div>
  </div>;
}
