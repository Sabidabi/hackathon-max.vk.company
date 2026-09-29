import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, Copy, Download, FilePlus2, MapPin } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import type { MenuChanges, RevisionConflict } from "../../../api/errors";
import type { MenuSection } from "../../../api/menu";
import type { Restaurant } from "../../../api/restaurants";
import {
  copyMenu,
  createMenu,
  fetchPointMenus,
  libraryPayload,
  savePointMenus,
  setMenuOnPoint,
  venueKeys,
  type MenuSummary,
} from "../../../api/venues";
import { Button, Chip, IconButton, Sheet, TextInput } from "../../../design";
import { showToast } from "../../../design/toast";
import { haptics } from "../../../max";

/** One action of an action sheet («⋮»). */
export interface SheetAction {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function ActionSheet({ open, title, actions, onClose }: { open: boolean; title: string; actions: SheetAction[]; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <ul className="menu-actions">
        {actions.map((action) => (
          <li key={action.label}>
            <button
              type="button"
              className={["menu-actions__item", action.danger && "menu-actions__item--danger"].filter(Boolean).join(" ")}
              disabled={action.disabled}
              onClick={() => { onClose(); action.onSelect(); }}
            >
              <span aria-hidden="true">{action.icon}</span>
              {action.label}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

function pointCount(ids: string[]): string {
  if (!ids.length) return "Не показывается в точках";
  return ids.length === 1 ? "1 точка" : `Точек: ${ids.length}`;
}

/**
 * Library of the venue's menus (P1-DOC-15): pick the menu to edit, «Новое меню»,
 * «Сделать копию», «Назначить точкам» and the tab order of this point.
 */
export function LibrarySheet({ open, onClose, menus, currentId, point, onPick, onCreate, onCopy, onAssign }: {
  open: boolean;
  onClose: () => void;
  menus: MenuSummary[];
  currentId: string | null;
  point: Restaurant;
  onPick: (menu: MenuSummary) => void;
  onCreate: () => void;
  onCopy: () => void;
  onAssign: () => void;
}) {
  const queryClient = useQueryClient();
  const assigned = useQuery({ queryKey: venueKeys.assignments(point.id), queryFn: () => fetchPointMenus(point.id), enabled: open });
  const reorder = useMutation({
    mutationFn: ({ from, to }: { from: number; to: number }) => {
      const current = assigned.data!;
      const list = current.assignments.map(({ menu_id, show_from, show_to }) => ({ menu_id, show_from, show_to }));
      const [moved] = list.splice(from, 1);
      list.splice(to, 0, moved);
      return savePointMenus(point.id, current.revision, list);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(venueKeys.assignments(point.id), result);
      void queryClient.invalidateQueries({ queryKey: ["restaurants"] });
    },
    onError: (error) => showToast(error.message, { tone: "danger" }),
  });
  const tabs = assigned.data?.assignments ?? [];
  return (
    <Sheet open={open} onClose={onClose} title="Меню заведения">
      <ul className="cabinet-choice" aria-label="Меню заведения">
        {menus.map((menu) => (
          <li key={menu.id}>
            <button type="button" className="cabinet-choice__item" aria-current={menu.id === currentId || undefined} onClick={() => onPick(menu)}>
              <span className="cabinet-choice__text">
                <strong>{menu.title}</strong>
                <small>
                  {menu.point_ids.includes(point.id) ? "В этой точке · " : ""}
                  {pointCount(menu.point_ids)}
                  {menu.published_version ? ` · версия ${menu.published_version}` : " · не опубликовано"}
                </small>
              </span>
              {menu.id === currentId && <Check size={20} aria-hidden="true" />}
            </button>
          </li>
        ))}
      </ul>
      <div className="menu-sheet-actions">
        <Button variant="secondary" icon={<FilePlus2 size={20} />} onClick={onCreate}>Новое меню</Button>
        <Button variant="secondary" icon={<Copy size={20} />} onClick={onCopy} disabled={!currentId}>Сделать копию</Button>
        <Button variant="secondary" icon={<MapPin size={20} />} onClick={onAssign} disabled={!currentId}>Назначить точкам</Button>
      </div>
      {tabs.length > 1 && (
        <section className="menu-tabs-order" aria-labelledby="menu-tabs-order">
          <h3 id="menu-tabs-order">Порядок вкладок в точке «{point.name}»</h3>
          <ol>
            {tabs.map((tab, index) => (
              <li key={tab.menu_id}>
                <span>{tab.title}{tab.show_from ? ` · ${tab.show_from.slice(0, 5)}–${tab.show_to?.slice(0, 5)}` : ""}</span>
                <IconButton aria-label={`Выше: ${tab.title}`} icon={<ArrowUp size={18} />} disabled={index === 0 || reorder.isPending} onClick={() => reorder.mutate({ from: index, to: index - 1 })} />
                <IconButton aria-label={`Ниже: ${tab.title}`} icon={<ArrowDown size={18} />} disabled={index === tabs.length - 1 || reorder.isPending} onClick={() => reorder.mutate({ from: index, to: index + 1 })} />
              </li>
            ))}
          </ol>
        </section>
      )}
    </Sheet>
  );
}

/** «Новое меню» / «Сделать копию»: just a title; points and hours come next. */
export function MenuTitleSheet({ open, mode, source, venueId, onClose, onCreated }: {
  open: boolean;
  mode: "new" | "copy";
  source: MenuSummary | null;
  venueId: string;
  onClose: () => void;
  onCreated: (menu: MenuSummary) => void;
}) {
  const queryClient = useQueryClient();
  const initialTitle = mode === "copy" && source?.title ? `${source.title} — копия` : "";
  const [title, setTitle] = useState(initialTitle);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      setTitle(initialTitle);
      setTouched(false);
    }
  }, [open, initialTitle]);
  const create = useMutation({
    mutationFn: () => (mode === "copy" && source ? copyMenu(source.id, title.trim()) : createMenu(venueId, title.trim())),
    onSuccess: (menu) => {
      haptics.notify("success");
      void queryClient.invalidateQueries({ queryKey: venueKeys.menus(venueId) });
      onCreated(menu);
    },
    onError: () => haptics.notify("error"),
  });
  return (
    <Sheet open={open} onClose={onClose} title={mode === "copy" ? "Копия меню" : "Новое меню"}>
      <form
        className="cabinet-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (title.trim()) create.mutate();
        }}
      >
        <TextInput label="Название" required maxLength={120} placeholder="Например, Завтраки" value={title} onChange={(event) => setTitle(event.target.value)} error={touched && !title.trim() ? "Назовите меню" : undefined} data-autofocus />
        {mode === "copy" && <p className="cabinet-muted">Копия — отдельное меню: правки не меняют «{source?.title}».</p>}
        {create.isError && <p className="cabinet-error" role="alert">{create.error.message}</p>}
        <Button type="submit" fullWidth loading={create.isPending}>{mode === "copy" ? "Сделать копию" : "Создать меню"}</Button>
      </form>
    </Sheet>
  );
}

const PRESETS: Array<{ label: string; from: string | null; to: string | null }> = [
  { label: "Весь день", from: null, to: null },
  { label: "Завтраки 08:00–12:00", from: "08:00", to: "12:00" },
  { label: "Обед 12:00–16:00", from: "12:00", to: "16:00" },
  { label: "Вечер 17:00–23:00", from: "17:00", to: "23:00" },
];

/**
 * «Назначить точкам»: chips of the venue's points and optional show hours (P1-DOC-15).
 * Removing a point is undoable from the toast.
 */
export function AssignSheet({ open, menu, points, currentPoint, onClose }: {
  open: boolean;
  menu: MenuSummary | null;
  points: Restaurant[];
  currentPoint: Restaurant;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const current = useQuery({ queryKey: venueKeys.assignments(currentPoint.id), queryFn: () => fetchPointMenus(currentPoint.id), enabled: open });
  useEffect(() => {
    if (!open || !menu) return;
    setSelected(menu.point_ids);
    const own = current.data?.assignments.find((item) => item.menu_id === menu.id);
    setFrom(own?.show_from?.slice(0, 5) ?? null);
    setTo(own?.show_to?.slice(0, 5) ?? null);
  }, [current.data, menu, open]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["venue-menus"] });
    void queryClient.invalidateQueries({ queryKey: ["point-menus"] });
    void queryClient.invalidateQueries({ queryKey: ["point-items"] });
    void queryClient.invalidateQueries({ queryKey: ["restaurants"] });
  };
  const hours = { show_from: from, show_to: to };
  const save = useMutation({
    mutationFn: async () => {
      const before = new Set(menu!.point_ids);
      const removed = points.filter((point) => before.has(point.id) && !selected.includes(point.id));
      for (const point of points) {
        const wanted = selected.includes(point.id);
        if (wanted || before.has(point.id)) await setMenuOnPoint(point.id, menu!.id, wanted, hours);
      }
      return removed;
    },
    onSuccess: (removed) => {
      haptics.notify("success");
      refresh();
      onClose();
      if (removed.length) {
        const names = removed.map((point) => `«${point.name}»`).join(", ");
        showToast(`«${menu!.title}» снято с ${names}`, {
          action: {
            label: "Отменить",
            onClick: () => {
              void Promise.all(removed.map((point) => setMenuOnPoint(point.id, menu!.id, true, hours))).then(refresh, (error: Error) => showToast(error.message, { tone: "danger" }));
            },
          },
        });
      } else {
        showToast("Назначения сохранены", { tone: "success" });
      }
    },
    onError: () => haptics.notify("error"),
  });
  const invalidHours = (from === null) !== (to === null) || (from !== null && from === to);
  return (
    <Sheet open={open} onClose={onClose} title={menu ? `Где показывать «${menu.title}»` : "Назначить точкам"}>
      <div className="cabinet-form">
        <div role="group" aria-label="Точки" className="menu-chips">
          {points.map((point) => {
            const on = selected.includes(point.id);
            return (
              <Chip key={point.id} selected={on} icon={on ? <Check size={18} /> : <MapPin size={18} />} onClick={() => setSelected((list) => (on ? list.filter((id) => id !== point.id) : [...list, point.id]))}>
                {point.name}
              </Chip>
            );
          })}
        </div>
        <div role="group" aria-label="Часы показа" className="menu-chips">
          {PRESETS.map((preset) => (
            <Chip key={preset.label} selected={from === preset.from && to === preset.to} onClick={() => { setFrom(preset.from); setTo(preset.to); }}>{preset.label}</Chip>
          ))}
        </div>
        <div className="menu-hours">
          <TextInput label="Показывать с" type="time" value={from ?? ""} onChange={(event) => setFrom(event.target.value || null)} />
          <TextInput label="до" type="time" value={to ?? ""} onChange={(event) => setTo(event.target.value || null)} error={invalidHours ? "Укажите оба времени, они не должны совпадать" : undefined} />
        </div>
        <p className="cabinet-muted">Часы — по времени каждой точки. Вне часов гости не видят это меню.</p>
        {save.isError && <p className="cabinet-error" role="alert">{save.error.message}</p>}
        <Button fullWidth loading={save.isPending} disabled={invalidHours || !menu} onClick={() => save.mutate()}>Сохранить</Button>
      </div>
    </Sheet>
  );
}

const FIELD_NAMES: Record<string, string> = {
  name: "название",
  price_minor: "цена",
  is_available: "наличие",
  description: "описание",
  weight_text: "вес/объём",
  image_url: "фото",
  configuration: "размеры и добавки",
};

function describeChange(field: string, before: unknown, after: unknown): string {
  if (field === "price_minor" && typeof before === "number" && typeof after === "number") {
    return `цена ${(before / 100).toLocaleString("ru-RU")} → ${(after / 100).toLocaleString("ru-RU")} ₽`;
  }
  return FIELD_NAMES[field] ?? field;
}

function ChangesList({ changes }: { changes: MenuChanges }) {
  const lines = [
    ...changes.added.map((item) => `Добавлено: ${item.name}`),
    ...changes.removed.map((item) => `Удалено: ${item.name}`),
    ...changes.changed.map((item) => `${item.name}: ${item.changes.map((change) => describeChange(change.field, change.before, change.after)).join(", ")}`),
    ...changes.sections_added.map((name) => `Новый раздел: ${name}`),
    ...changes.sections_removed.map((name) => `Удалён раздел: ${name}`),
  ];
  if (!lines.length) return null;
  return (
    <ul className="menu-conflict__changes">
      {lines.slice(0, 8).map((line) => <li key={line}>{line}</li>)}
      {lines.length > 8 && <li>И ещё {lines.length - 8}</li>}
    </ul>
  );
}

/**
 * 409 on a stale revision (P1-DOC-7 «Защита от конкурентных правок»): nothing is lost —
 * the local edits stay on this device until the admin applies them over the new draft,
 * takes the other version or downloads a copy.
 */
export function ConflictSheet({ open, conflict, sections, busy, error, onApplyMine, onTakeTheirs, onClose }: {
  open: boolean;
  conflict: RevisionConflict | null;
  sections: MenuSection[];
  busy: "mine" | "theirs" | null;
  error: string | null;
  onApplyMine: () => void;
  onTakeTheirs: () => void;
  onClose: () => void;
}) {
  const publication = conflict?.last_publication;
  // Overwriting other admins' draft edits needs an explicit second step (P1-DOC-15 «Безопасность правок»).
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (!open) setConfirming(false); }, [open]);
  const hasTheirChanges = Boolean(conflict?.changes && conflict.changes.total_changes > 0);
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(libraryPayload(sections), null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "menu-my-changes.json";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Меню изменили на другом устройстве"
      footer={confirming ? (
        <>
          <Button variant="secondary" disabled={busy !== null} onClick={() => setConfirming(false)}>Не перезаписывать</Button>
          <Button variant="danger" loading={busy === "mine"} disabled={busy !== null} onClick={onApplyMine}>Перезаписать их правки</Button>
        </>
      ) : (
        <>
          <Button variant="secondary" icon={<Download size={20} />} disabled={busy !== null} onClick={download}>Скачать мою копию</Button>
          <Button loading={busy === "theirs"} disabled={busy !== null} onClick={onTakeTheirs}>Обновить без моих правок</Button>
        </>
      )}
    >
      <div className="cabinet-stack">
        {confirming ? (
          <>
            <p className="menu-conflict__lead">Ваш вариант заменит правки другого администратора.</p>
            {hasTheirChanges && conflict?.changes
              ? <><h3 className="menu-conflict__title">Будет перезаписано</h3><ChangesList changes={conflict.changes} /></>
              : <p className="cabinet-muted">Будет перезаписан черновик, сохранённый другим администратором.</p>}
          </>
        ) : (
          <>
            <p className="menu-conflict__lead">Ваши правки не потеряны — они сохранены на этом устройстве.</p>
            {publication && (
              <p className="cabinet-muted">
                {publication.author ? `${publication.author.display_name} опубликовал(а)` : "Опубликована"} версию {publication.version}
                {publication.published_at ? ` · ${new Date(publication.published_at).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}` : ""}
              </p>
            )}
            {hasTheirChanges && conflict?.changes
              ? <><h3 className="menu-conflict__title">Что изменили другие</h3><ChangesList changes={conflict.changes} /></>
              : <p className="cabinet-muted">Другой администратор сохранил черновик этого меню.</p>}
            <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirming(true)}>Обновить и применить мои</Button>
          </>
        )}
        {error && <p className="cabinet-error" role="alert">{error}</p>}
      </div>
    </Sheet>
  );
}
