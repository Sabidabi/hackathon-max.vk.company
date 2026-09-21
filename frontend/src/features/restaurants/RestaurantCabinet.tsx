import { Store, Utensils, Palette, QrCode, Upload, Bell } from "lucide-react";
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

function RestaurantForm({ restaurant, onCreated }: { restaurant?: Restaurant; onCreated?: () => void }) {
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
      if (!restaurant) onCreated?.();
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

export function RestaurantCabinet() {
  const [step, setStep] = useState("menu");
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  if (!restaurant) return <section className="onboarding-card" id="restaurant-cabinet"><span className="onboarding-icon"><Store size={28} /></span><h2>Новая точка</h2><p className="muted">Начнём с названия и адреса.</p><RestaurantForm onCreated={() => setStep("menu")} /></section>;
  const navigation = [ { id: "menu", label: "Меню", Icon: Utensils }, { id: "profile", label: "Точка", Icon: Store }, { id: "design", label: "Оформление", Icon: Palette }, { id: "share", label: "QR-код", Icon: QrCode }, ...(["owner", "manager"].includes(restaurant.role) ? [{ id: "notifications", label: "Рассылки", Icon: Bell }] : []) ];
  return <div className="cabinet-layout" id="restaurant-cabinet" key={restaurant.id}>
    <aside className="cabinet-sidebar"><div className="venue-switch"><span className="venue-icon"><Store size={20} /></span><div><strong>{restaurant.name}</strong><small>{restaurant.address || "Адрес не указан"}</small></div></div>
      {restaurants.data.length > 1 && <select aria-label="Выбрать точку" value={restaurant.id} onChange={(event) => { if (window.confirm("Переключить точку? Сохраните изменения перед переходом.")) setSelectedId(event.target.value); }}>{restaurants.data.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
      <nav className="cabinet-steps" aria-label="Кабинет">{navigation.map(({ id, label, Icon }) => <button type="button" key={id} aria-current={step === id ? "page" : undefined} onClick={() => setStep(id)}><Icon size={19} /><span>{label}</span></button>)}</nav>
      <div className="sidebar-status"><span className={`status-dot ${restaurant.current_published_version_id ? "is-live" : ""}`} />{restaurant.current_published_version_id ? "Меню опубликовано" : "Черновик"}</div>
    </aside>
    <div className="cabinet-content">
      <div hidden={step !== "profile"}><div className="workspace-title"><h2>Точка</h2><Help label="О данных точки">Название, адрес и описание обновляются для гостей после сохранения. Часы работы и контакты находятся в оформлении.</Help></div><div className="profile-card"><RestaurantForm restaurant={restaurant} /></div></div>
      <div hidden={step !== "menu"}><DraftEditor restaurantId={restaurant.id} publicId={restaurant.public_id} isPublished={Boolean(restaurant.current_published_version_id)} canPublish={["owner", "manager"].includes(restaurant.role)} /><details className="import-disclosure"><summary><Upload size={16} />Импорт PDF / фото</summary><MenuUpload restaurantId={restaurant.id} /></details></div>
      <div hidden={step !== "design"}><SiteBuilder restaurant={restaurant} /></div>
      <div hidden={step !== "share"}><MenuShare restaurantId={restaurant.id} published={Boolean(restaurant.current_published_version_id)} /></div>
      <div hidden={step !== "notifications"}><NotificationCenter restaurantId={restaurant.id} /></div>
    </div>
  </div>;
}
