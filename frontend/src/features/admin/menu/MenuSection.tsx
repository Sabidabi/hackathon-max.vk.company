import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CloudUpload,
  Coffee,
  EllipsisVertical,
  Eye,
  FilePlus2,
  History,
  ListChecks,
  ListPlus,
  MapPin,
  Pencil,
  Search,
  Sparkles,
  Store,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { trackAdmin } from "../../../analytics";
import { emptyConfiguration, type MenuItem, type MenuSection as Section } from "../../../api/menu";
import {
  applyMenuTemplate,
  fetchPointItems,
  listVenueMenus,
  patchPointItem,
  publishLibraryMenu,
  setVenueItemAvailability,
  venueKeys,
  type MenuSummary,
  type PointItems,
  type PointItemState,
} from "../../../api/venues";
import { Button, Chip, EmptyState, IconButton, RollingNumber, Sheet, Skeleton } from "../../../design";
import { flip, measure, type Snapshot } from "../../../design/motion";
import { showToast } from "../../../design/toast";
import { haptics } from "../../../max";
import { AiMenuComposer } from "../../menu/AiMenuComposer";
import type { CabinetContext } from "../shell/CabinetShell";
import { GuestPreview } from "./GuestPreview";
import { hasPrice, MenuStart, StartChecklist } from "./MenuStart";
import { MenuCheckSheet } from "./MenuCheckSheet";
import { HistorySheet, PublishSheet } from "./PublishSheets";
import { ItemSheet } from "./ItemSheet";
import { ItemRow, QuickAdd, type RowState } from "./MenuRows";
import { ActionSheet, AssignSheet, ConflictSheet, LibrarySheet, MenuTitleSheet, type SheetAction } from "./MenuSheets";
import { useMenuDraft } from "./useMenuDraft";
import "./menu.css";

const MAX_SECTIONS = 100;
const MAX_ITEMS = 1000;

const ONBOARDING = (pointId: string) => `sinitsa:onboarding:${pointId}`;

/** The checklist stays after the wizard until every step is done (per device). */
function startOnboarding(pointId: string): void {
  try { window.localStorage.setItem(ONBOARDING(pointId), "1"); } catch { /* private mode */ }
}

function onboardingActive(pointId: string): boolean {
  try { return window.localStorage.getItem(ONBOARDING(pointId)) === "1"; } catch { return false; }
}

function newItem(name: string, price: number): MenuItem {
  return {
    configuration: emptyConfiguration(),
    id: crypto.randomUUID(),
    name,
    description: null,
    image_url: null,
    price_minor: price,
    currency: "RUB",
    weight_text: null,
    ingredients: null,
    allergens: [],
    is_available: true,
    source_confidence: null,
  };
}

function move<T>(list: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

const STATUS_TEXT = {
  loading: "Загружаем…",
  saved: "Сохранено",
  saving: "Сохраняем…",
  invalid: "Проверьте позиции",
  error: "Не сохранено",
  conflict: "Конфликт",
} as const;

type ItemAction = { kind: "item"; sectionId: string; itemId: string } | { kind: "section"; sectionId: string } | { kind: "menu" };

/**
 * «Меню» (P1-TASK-27, P1-DOC-7, P1-DOC-15): the library menu edited for this venue, its
 * sections and compact rows with the availability switch of the CURRENT point (stop-list:
 * applied at once, undo in a toast), quick «Латте 190» + Enter, search and «Нет в наличии»,
 * autosave with a status and a sticky «Опубликовать изменения (N)» — the only blue button.
 */
export function MenuSection({ context, focusItem, onUnsavedChange, onChangesCount }: {
  context: CabinetContext;
  focusItem: { section: string | null; name: string } | null;
  onUnsavedChange: (unsaved: boolean) => void;
  onChangesCount: (count: number) => void;
}) {
  const { point, venuePoints } = context;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const menus = useQuery({ queryKey: venueKeys.menus(point.venue_id), queryFn: () => listVenueMenus(point.venue_id) });
  const requested = params.get("menu");
  const menu: MenuSummary | null = menus.data?.find((item) => item.id === requested)
    ?? menus.data?.find((item) => item.id === point.menu_id)
    ?? menus.data?.find((item) => item.point_ids.includes(point.id))
    ?? menus.data?.[0]
    ?? null;
  const menuId = menu?.id ?? null;
  const editor = useMenuDraft(menuId, menu?.published_version ?? null);
  const { sections, setSections, status } = editor;
  const pointItems = useQuery({ queryKey: venueKeys.items(point.id), queryFn: () => fetchPointItems(point.id) });

  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [onlyOff, setOnlyOff] = useState(false);
  const [selected, setSelected] = useState<{ sectionId: string; itemId: string; origin: HTMLElement | null } | null>(null);
  const [actions, setActions] = useState<ItemAction | null>(null);
  const [sheet, setSheet] = useState<null | "library" | "new-menu" | "copy-menu" | "assign" | "preview" | "conflict" | "publish" | "history" | "ai" | "check">(null);
  const [assignTarget, setAssignTarget] = useState<MenuSummary | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [pendingToggle, setPendingToggle] = useState<Set<string>>(new Set());
  const [publishState, setPublishState] = useState<"idle" | "progress" | "success">("idle");

  // FLIP: rows keep their place visually when one is added, moved or removed (P1-DOC-18).
  const listRef = useRef<HTMLDivElement>(null);
  const flipBefore = useRef<Snapshot | null>(null);
  const captureFlip = () => {
    if (listRef.current) flipBefore.current = measure(listRef.current.querySelectorAll("[data-flip]"));
  };
  useLayoutEffect(() => {
    if (!flipBefore.current || !listRef.current) return;
    flip(flipBefore.current, listRef.current.querySelectorAll("[data-flip]"));
    flipBefore.current = null;
  }, [sections]);

  const unpublished = menu?.unpublished_changes ?? 0;
  useEffect(() => onUnsavedChange(editor.dirty || editor.saving), [editor.dirty, editor.saving, onUnsavedChange]);
  useEffect(() => () => onUnsavedChange(false), [onUnsavedChange]);
  useEffect(() => onChangesCount(unpublished), [onChangesCount, unpublished]);
  useEffect(() => () => onChangesCount(0), [onChangesCount]);
  useEffect(() => {
    if (editor.conflict) setSheet("conflict");
  }, [editor.conflict]);

  // «Редактировать» from the guest menu: open that item's card once the draft is loaded.
  const focusApplied = useRef<string | null>(null);
  useEffect(() => {
    if (!editor.loaded || !focusItem) return;
    const key = `${focusItem.section ?? ""}\u0000${focusItem.name}`;
    if (focusApplied.current === key) return;
    focusApplied.current = key;
    const ordered = [...sections.filter((section) => section.name === focusItem.section), ...sections.filter((section) => section.name !== focusItem.section)];
    for (const section of ordered) {
      const item = section.items.find((entry) => entry.name === focusItem.name);
      if (item) {
        setSelected({ sectionId: section.id, itemId: item.id, origin: null });
        return;
      }
    }
  }, [editor.loaded, focusItem, sections]);

  // --- Point stop-list (applied at once, P1-DOC-15) --------------------------------------
  const pointState = useMemo(() => {
    const map = new Map<string, PointItemState>();
    const data = pointItems.data?.menus.find((entry) => entry.menu_id === menuId);
    for (const item of data?.items ?? []) map.set(item.item_key, item);
    return map;
  }, [menuId, pointItems.data]);

  const setPointAvailability = (key: string, available: boolean | null) => {
    queryClient.setQueryData<PointItems>(venueKeys.items(point.id), (current) => current && {
      ...current,
      menus: current.menus.map((entry) => ({
        ...entry,
        items: entry.items.map((item) => item.item_key !== key ? item : {
          ...item,
          effective_is_available: available ?? item.menu_is_available,
          override: available === null && !item.override?.price_minor ? null : { available, price_minor: item.override?.price_minor ?? null, variant_prices: item.override?.variant_prices ?? {} },
        }),
      })),
    });
  };

  const toggle = useMutation({
    mutationFn: ({ key, available }: { key: string; available: boolean | null; previous: boolean | null; name: string; silent?: boolean }) => patchPointItem(point.id, key, { available }),
    onMutate: ({ key, available }) => {
      setPendingToggle((current) => new Set(current).add(key));
      setPointAvailability(key, available);
    },
    onSuccess: (_result, { key, available, previous, name, silent }) => {
      if (silent) return;
      if (available === false) {
        showToast(`«${name}» скрыт на точке «${point.name}»`, {
          action: { label: "Отменить", onClick: () => toggle.mutate({ key, available: previous, previous: false, name, silent: true }) },
        });
      } else {
        showToast(`«${name}» снова в наличии`, {
          action: { label: "Отменить", onClick: () => toggle.mutate({ key, available: previous, previous: available, name, silent: true }) },
        });
      }
    },
    onError: (error, { key, previous }) => {
      setPointAvailability(key, previous);
      haptics.notify("error");
      showToast(error.message, { tone: "danger" });
    },
    onSettled: (_result, _error, { key }) => {
      setPendingToggle((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: venueKeys.items(point.id) });
    },
  });

  const everywhere = useMutation({
    mutationFn: ({ key, available }: { key: string; available: boolean; name: string }) => setVenueItemAvailability(point.venue_id, key, available),
    onSuccess: (result, { available, name }) => {
      haptics.notify("success");
      showToast(`«${name}»: ${available ? "в наличии" : "нет в наличии"} во всех точках (${result.point_ids.length})`);
      void queryClient.invalidateQueries({ queryKey: ["point-items"] });
    },
    onError: (error) => showToast(error.message, { tone: "danger" }),
  });

  const rowState = (item: MenuItem): RowState => {
    const state = item.item_key ? pointState.get(item.item_key) : undefined;
    if (state) {
      return {
        available: state.effective_is_available,
        pointLevel: true,
        busy: pendingToggle.has(state.item_key),
        error: state.effective_is_available ? null : state.availability_error ? `Нельзя продать: ${state.availability_error}` : null,
      };
    }
    return { available: item.is_available, pointLevel: false, busy: false, error: null };
  };

  // --- Draft edits ------------------------------------------------------------------------
  const updateItem = useCallback((sectionId: string, itemId: string, patch: Partial<MenuItem>) => {
    setSections((current) => current.map((section) => section.id !== sectionId ? section : {
      ...section,
      items: section.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
    }));
  }, [setSections]);
  const updateSection = (sectionId: string, patch: Partial<Section>) => {
    setSections((current) => current.map((section) => (section.id === sectionId ? { ...section, ...patch } : section)));
  };
  const itemCount = sections.reduce((sum, section) => sum + section.items.length, 0);

  const onToggle = (item: MenuItem, sectionId: string, next: boolean) => {
    const state = item.item_key ? pointState.get(item.item_key) : undefined;
    if (state) {
      toggle.mutate({ key: state.item_key, available: next, previous: state.override?.available ?? null, name: item.name });
      return;
    }
    // Not published at this point yet: availability is part of the draft.
    updateItem(sectionId, item.id, { is_available: next });
    if (!next) {
      showToast(`«${item.name}» выключен в черновике`, { action: { label: "Отменить", onClick: () => updateItem(sectionId, item.id, { is_available: true }) } });
    }
  };

  const addItem = (sectionId: string, name: string, price: number) => {
    if (itemCount >= MAX_ITEMS) {
      showToast("В меню не больше 1000 позиций", { tone: "danger" });
      return;
    }
    captureFlip();
    setSections((current) => current.map((section) => (section.id === sectionId ? { ...section, items: [...section.items, newItem(name, price)] } : section)));
  };
  const addSection = () => {
    if (sections.length >= MAX_SECTIONS) return;
    const id = crypto.randomUUID();
    captureFlip();
    setSections((current) => [...current, { id, name: current.length ? "Новый раздел" : "Кофе", items: [] }]);
    setRenaming(id);
  };
  const removeItem = (sectionId: string, itemId: string) => {
    const before = sections;
    const item = sections.find((section) => section.id === sectionId)?.items.find((entry) => entry.id === itemId);
    captureFlip();
    setSections((current) => current.map((section) => (section.id === sectionId ? { ...section, items: section.items.filter((entry) => entry.id !== itemId) } : section)));
    showToast(`«${item?.name ?? "Позиция"}» удалена`, { action: { label: "Отменить", onClick: () => { captureFlip(); setSections(before); } } });
  };
  const removeSection = (sectionId: string) => {
    const before = sections;
    const section = sections.find((entry) => entry.id === sectionId);
    captureFlip();
    setSections((current) => current.filter((entry) => entry.id !== sectionId));
    showToast(`Раздел «${section?.name ?? ""}» удалён`, { action: { label: "Отменить", onClick: () => { captureFlip(); setSections(before); } } });
  };

  // --- «Шаблон кофейни»: server template without prices, into the draft only -----------------
  const template = useMutation({
    mutationFn: () => applyMenuTemplate(menuId!, editor.revision),
    onSuccess: (draft) => {
      editor.adopt(draft);
      haptics.notify("success");
      void queryClient.invalidateQueries({ queryKey: ["venue-menus"] });
      showToast("Шаблон добавлен — поставьте цены", { tone: "success" });
    },
    onError: () => haptics.notify("error"),
  });

  // --- Publication ------------------------------------------------------------------------
  const publish = useMutation({
    mutationFn: () => publishLibraryMenu(menuId!, editor.revision, menu!.point_ids, editor.seenVersion.current),
    onMutate: () => setPublishState("progress"),
    onSuccess: (result) => {
      haptics.notify("success");
      setPublishState("success");
      trackAdmin("menu_published", { menu_id: menuId ?? null, count: menu?.point_ids.length ?? 0 });
      editor.seenVersion.current = result.version;
      showToast(`Опубликовано · версия ${result.version}`, { tone: "success" });
      window.setTimeout(() => setPublishState("idle"), 1_200);
      void queryClient.invalidateQueries({ queryKey: ["venue-menus"] });
      void queryClient.invalidateQueries({ queryKey: ["restaurants"] });
      void queryClient.invalidateQueries({ queryKey: ["point-items"] });
      void queryClient.invalidateQueries({ queryKey: ["public-menu"] });
      void queryClient.invalidateQueries({ queryKey: ["menu-versions"] });
    },
    onError: () => {
      haptics.notify("error");
      setPublishState("idle");
    },
  });
  const availableSomewhere = sections.some((section) => section.items.some((item) => item.is_available));
  const publishBlocker = editor.problem
    ?? (!itemCount ? "Добавьте позиции" : !availableSomewhere ? "Все позиции выключены" : null);
  const canPublish = Boolean(menu && menu.point_ids.length && !publishBlocker && status === "saved" && !publish.isPending);
  const startPublish = () => {
    if (!menu || publish.isPending || publishState !== "idle") return;
    haptics.impact("light");
    setSheet("publish");
  };
  const fixProblem = (itemKey: string | null) => {
    for (const section of sections) {
      const item = section.items.find((entry) => entry.item_key === itemKey);
      if (item) {
        setSheet(null);
        setSelected({ sectionId: section.id, itemId: item.id, origin: null });
        return;
      }
    }
  };
  const showPublishBar = Boolean(menu) && (unpublished > 0 || editor.dirty || status === "saving" || publishState !== "idle" || (menu && !menu.published_version && itemCount > 0));

  const pickMenu = (next: MenuSummary) => {
    if (editor.dirty || editor.saving) {
      showToast("Сохраняем меню — переключитесь через секунду");
      return;
    }
    setSheet(null);
    const nextParams = new URLSearchParams(params);
    nextParams.set("menu", next.id);
    nextParams.delete("item");
    nextParams.delete("section");
    setParams(nextParams, { replace: true });
  };

  const isAvailable = (item: MenuItem) => rowState(item).available;
  const primary = menuId !== null && menuId === point.menu_id;
  const query = search.trim().toLocaleLowerCase("ru");
  const matches = (item: MenuItem) =>
    (!query || `${item.name} ${item.description ?? ""}`.toLocaleLowerCase("ru").includes(query)) && (!onlyOff || !isAvailable(item));
  const filtering = Boolean(query) || onlyOff;
  const selectedItem = selected ? sections.find((section) => section.id === selected.sectionId)?.items.find((item) => item.id === selected.itemId) : undefined;

  // --- Action sheets ----------------------------------------------------------------------
  const actionList = (): { title: string; items: SheetAction[] } => {
    if (!actions) return { title: "", items: [] };
    if (actions.kind === "menu") {
      return {
        title: menu?.title ?? "Меню",
        items: [
          { label: "Новое меню", icon: <FilePlus2 size={20} />, onSelect: () => setSheet("new-menu") },
          { label: "Сделать копию", icon: <ListPlus size={20} />, onSelect: () => setSheet("copy-menu"), disabled: !menu },
          { label: "Назначить точкам", icon: <MapPin size={20} />, onSelect: () => { setAssignTarget(menu); setSheet("assign"); }, disabled: !menu },
          { label: "История версий", icon: <History size={20} />, onSelect: () => setSheet("history"), disabled: !menu },
          { label: "Проверить меню", icon: <ListChecks size={20} />, onSelect: () => setSheet("check"), disabled: !menu || !sections.length || editor.dirty || editor.saving },
          ...(primary ? [{ label: "Добавить с ИИ", icon: <Sparkles size={20} />, onSelect: () => setSheet("ai"), disabled: editor.dirty || editor.saving }] : []),
          ...(primary ? [{ label: "Импорт PDF или фото", icon: <Upload size={20} />, onSelect: () => navigate(`/manage/${point.public_id}/more/import`) }] : []),
        ],
      };
    }
    const sectionIndex = sections.findIndex((section) => section.id === actions.sectionId);
    const section = sections[sectionIndex];
    if (!section) return { title: "", items: [] };
    if (actions.kind === "section") {
      return {
        title: section.name,
        items: [
          { label: "Переименовать", icon: <Pencil size={20} />, onSelect: () => setRenaming(section.id) },
          { label: "Выше", icon: <ArrowUp size={20} />, disabled: sectionIndex === 0, onSelect: () => { captureFlip(); setSections((current) => move(current, sectionIndex, -1)); } },
          { label: "Ниже", icon: <ArrowDown size={20} />, disabled: sectionIndex === sections.length - 1, onSelect: () => { captureFlip(); setSections((current) => move(current, sectionIndex, 1)); } },
          { label: "Удалить раздел", icon: <Trash2 size={20} />, danger: true, onSelect: () => removeSection(section.id) },
        ],
      };
    }
    const itemIndex = section.items.findIndex((item) => item.id === actions.itemId);
    const item = section.items[itemIndex];
    if (!item) return { title: "", items: [] };
    const state = item.item_key ? pointState.get(item.item_key) : undefined;
    const multi = venuePoints.length > 1 && state;
    return {
      title: item.name,
      items: [
        { label: "Изменить", icon: <Pencil size={20} />, onSelect: () => setSelected({ sectionId: section.id, itemId: item.id, origin: null }) },
        { label: "Выше", icon: <ArrowUp size={20} />, disabled: itemIndex === 0, onSelect: () => { captureFlip(); updateSection(section.id, { items: move(section.items, itemIndex, -1) }); } },
        { label: "Ниже", icon: <ArrowDown size={20} />, disabled: itemIndex === section.items.length - 1, onSelect: () => { captureFlip(); updateSection(section.id, { items: move(section.items, itemIndex, 1) }); } },
        ...(multi ? [
          { label: "Нет в наличии во всех точках", icon: <Store size={20} />, onSelect: () => everywhere.mutate({ key: state.item_key, available: false, name: item.name }) },
          { label: "В наличии во всех точках", icon: <Check size={20} />, onSelect: () => everywhere.mutate({ key: state.item_key, available: true, name: item.name }) },
        ] : []),
        { label: "Удалить позицию", icon: <Trash2 size={20} />, danger: true, onSelect: () => removeItem(section.id, item.id) },
      ],
    };
  };
  const currentActions = actionList();

  // --- Render -----------------------------------------------------------------------------
  if (menus.isPending || (menuId && !editor.loaded && !editor.draft.isError)) {
    return (
      <div className="menu-page" aria-busy="true" aria-label="Загружаем меню">
        <div className="menu-toolbar"><Skeleton width={160} height={28} /></div>
        <div className="menu-skeleton">
          <Skeleton width="30%" height={22} />
          {[0, 1, 2, 3, 4, 5].map((row) => <Skeleton key={row} height={60} radius="control" />)}
        </div>
      </div>
    );
  }
  if (menus.isError || editor.draft.isError) {
    const error = menus.error ?? editor.draft.error;
    return (
      <EmptyState icon={<AlertTriangle size={28} />} tone="danger" title="Меню не загрузилось" action={<Button onClick={() => { void menus.refetch(); void editor.draft.refetch(); }}>Попробовать снова</Button>}>
        {error?.message}
      </EmptyState>
    );
  }
  if (!menu) {
    return (
      <EmptyState icon={<Coffee size={28} />} title="В заведении пока нет меню" action={<Button icon={<FilePlus2 size={20} />} onClick={() => setSheet("new-menu")}>Создать меню</Button>}>
        Создайте меню и назначьте его точкам.
        <MenuTitleSheet open={sheet === "new-menu"} mode="new" source={null} venueId={point.venue_id} onClose={() => setSheet(null)} onCreated={(created) => { setSheet(null); pickMenu(created); }} />
      </EmptyState>
    );
  }

  const notOnPoint = !menu.point_ids.includes(point.id);
  const onboarding = onboardingActive(point.id) || !sections.length;
  const checklistStep = (step: "items" | "prices" | "design" | "publish" | "qr") => {
    if (step === "items") addSection();
    else if (step === "prices") {
      for (const section of sections) {
        const item = section.items.find((entry) => entry.is_available && !hasPrice(entry));
        if (item) { setSelected({ sectionId: section.id, itemId: item.id, origin: null }); return; }
      }
    } else if (step === "design") navigate(`/manage/${point.public_id}/design`);
    else if (step === "publish") startPublish();
    else navigate(`/manage/${point.public_id}/more/qr`);
  };
  const preview = <GuestPreview title={point.venue_name ?? point.name} sections={sections} available={isAvailable} />;

  return (
    <div className="menu-page">
      <div className="menu-layout">
        <div className="menu-main">
          <div className="menu-toolbar">
<div className="menu-toolbar__title">
                        <button type="button" className="menu-picker" aria-haspopup="dialog" aria-label={`Меню «${menu.title}». Библиотека меню`} onClick={() => setSheet("library")}>
              <span className="menu-picker__title">{menu.title}</span>
              <ChevronDown size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`menu-status menu-status--${status}`}
              role="status"
              aria-live="polite"
              disabled={status !== "conflict" && status !== "error"}
              onClick={() => (status === "conflict" ? setSheet("conflict") : editor.retrySave())}
            >
              {status === "saved" && <Check size={14} aria-hidden="true" />}
              {STATUS_TEXT[status]}
            </button>
            </div>
            <IconButton aria-label={searchOpen ? "Скрыть поиск" : "Поиск по позициям"} icon={searchOpen ? <X size={22} /> : <Search size={22} />} onClick={() => { setSearchOpen((open) => !open); if (searchOpen) { setSearch(""); setOnlyOff(false); } }} />
            <IconButton className="menu-preview-button" aria-label="Как увидит гость" icon={<Eye size={22} />} onClick={() => setSheet("preview")} />
            <IconButton aria-label="Действия с меню" icon={<EllipsisVertical size={22} />} onClick={() => setActions({ kind: "menu" })} />
          </div>

          {searchOpen && (
            <div className="menu-search">
              <label className="menu-search__field">
                <Search size={18} aria-hidden="true" />
                <input type="search" aria-label="Поиск позиций" placeholder="Название или описание" value={search} onChange={(event) => setSearch(event.target.value)} autoFocus />
              </label>
              <Chip selected={onlyOff} onClick={() => setOnlyOff((value) => !value)}>Нет в наличии</Chip>
            </div>
          )}

          {notOnPoint && (
            <p className="menu-note">
              «{menu.title}» не показывается на точке «{point.name}».
              <button type="button" onClick={() => { setAssignTarget(menu); setSheet("assign"); }}>Назначить</button>
            </p>
          )}
          {editor.saveError && (
            <p className="menu-note menu-note--danger" role="alert">
              {editor.saveError.message}
              <button type="button" onClick={() => editor.retrySave()}>Повторить</button>
            </p>
          )}

          {onboarding && primary && sections.length > 0 && (
            <StartChecklist pointId={point.id} sections={sections} published={Boolean(menu.published_version)} onStep={checklistStep} />
          )}
          {!sections.length ? (
            <MenuStart
              onPhoto={primary ? () => { startOnboarding(point.id); navigate(`/manage/${point.public_id}/more/import`); } : null}
              onDescribe={primary ? () => { startOnboarding(point.id); setSheet("ai"); } : null}
              onTemplate={() => { startOnboarding(point.id); template.mutate(); }}
              onManual={() => { startOnboarding(point.id); addSection(); }}
              templateBusy={template.isPending}
              error={template.isError ? template.error.message : null}
            />
          ) : (
            <div className="menu-sections" ref={listRef}>
              {sections.map((section) => {
                const visible = section.items.filter(matches);
                if (filtering && !visible.length) return null;
                return (
                  <section key={section.id} className="menu-group" data-flip={`section-${section.id}`} aria-label={section.name}>
                    <header className="menu-group__header">
                      {renaming === section.id ? (
                        <input
                          className="menu-group__rename"
                          aria-label="Название раздела"
                          autoFocus
                          maxLength={200}
                          defaultValue={section.name}
                          onFocus={(event) => event.target.select()}
                          onBlur={(event) => { updateSection(section.id, { name: event.target.value.trim() || section.name }); setRenaming(null); }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") setRenaming(null);
                          }}
                        />
                      ) : (
                        <button type="button" className="menu-group__title" aria-label={`Раздел «${section.name}». Переименовать`} onClick={() => setRenaming(section.id)}>
                          <h2>{section.name}</h2>
                          <span className="menu-group__count">{section.items.length}</span>
                        </button>
                      )}
                      <IconButton aria-label={`Действия с разделом «${section.name}»`} icon={<EllipsisVertical size={20} />} onClick={() => setActions({ kind: "section", sectionId: section.id })} />
                    </header>
                    <div className="menu-group__rows">
                      {visible.map((item) => (
                        <ItemRow
                          key={item.id}
                          item={item}
                          state={rowState(item)}
                          pointName={point.name}
                          onOpen={(origin) => setSelected({ sectionId: section.id, itemId: item.id, origin })}
                          onToggle={(next) => onToggle(item, section.id, next)}
                          onActions={() => setActions({ kind: "item", sectionId: section.id, itemId: item.id })}
                        />
                      ))}
                      {!filtering && <QuickAdd section={section} disabled={section.items.length >= 300} onAdd={(name, price) => addItem(section.id, name, price)} />}
                    </div>
                  </section>
                );
              })}
              {filtering && !sections.some((section) => section.items.some(matches)) && (
                <p className="menu-note">{onlyOff ? "Все позиции в наличии." : "Ничего не нашлось."}</p>
              )}
              {!filtering && (
                <Button variant="ghost" icon={<ListPlus size={20} />} onClick={addSection} disabled={sections.length >= MAX_SECTIONS}>Раздел</Button>
              )}
            </div>
          )}
        </div>
        <aside className="menu-phone" aria-label="Как увидит гость">
          <p className="menu-phone__label"><Eye size={16} aria-hidden="true" />Как увидит гость</p>
          <div className="menu-phone__frame">{preview}</div>
        </aside>
      </div>

      {showPublishBar && (
        <div className="menu-publish" data-toast-avoid role="region" aria-label="Публикация">
          <span className="menu-publish__text">
            {publishBlocker ?? (menu.point_ids.length ? (menu.published_version ? "Гости увидят изменения после публикации" : "Меню ещё не видно гостям") : "Меню не назначено точкам")}
          </span>
          {menu.point_ids.length ? (
            <Button
              icon={<CloudUpload size={20} />}
              status={publishState}
              disabled={publishState !== "idle" || !canPublish}
              aria-label={`Опубликовать изменения: ${unpublished}`}
              onClick={startPublish}
            >
              Опубликовать изменения{unpublished ? <> (<RollingNumber value={unpublished} />)</> : null}
            </Button>
          ) : (
            <Button variant="secondary" icon={<MapPin size={20} />} onClick={() => { setAssignTarget(menu); setSheet("assign"); }}>Назначить точкам</Button>
          )}
          {publish.isError && <p className="cabinet-error menu-publish__error" role="alert">{publish.error.message}</p>}
        </div>
      )}

      <ItemSheet
        open={Boolean(selected && selectedItem)}
        item={selectedItem ?? null}
        origin={selected?.origin ?? null}
        point={point}
        pointState={selectedItem?.item_key ? pointState.get(selectedItem.item_key) ?? null : null}
        status={status}
        menuId={menuId}
        revision={editor.revision}
        sectionName={selected ? sections.find((section) => section.id === selected.sectionId)?.name ?? null : null}
        onChange={(patch) => selected && updateItem(selected.sectionId, selected.itemId, patch)}
        onClose={() => setSelected(null)}
      />

      <ActionSheet open={actions !== null} title={currentActions.title} actions={currentActions.items} onClose={() => setActions(null)} />

      <LibrarySheet
        open={sheet === "library"}
        onClose={() => setSheet(null)}
        menus={menus.data ?? []}
        currentId={menuId}
        point={point}
        onPick={pickMenu}
        onCreate={() => setSheet("new-menu")}
        onCopy={() => setSheet("copy-menu")}
        onAssign={() => { setAssignTarget(menu); setSheet("assign"); }}
      />
      <MenuTitleSheet
        open={sheet === "new-menu" || sheet === "copy-menu"}
        mode={sheet === "copy-menu" ? "copy" : "new"}
        source={menu}
        venueId={point.venue_id}
        onClose={() => setSheet(null)}
        onCreated={(created) => {
          pickMenu(created);
          setAssignTarget({ ...created, point_ids: [] });
          setSheet("assign");
        }}
      />
      <AssignSheet open={sheet === "assign"} menu={assignTarget} points={venuePoints} currentPoint={point} onClose={() => setSheet(null)} />
      <ConflictSheet
        open={sheet === "conflict" && Boolean(editor.conflict)}
        conflict={editor.conflict}
        sections={sections}
        busy={editor.resolve.isPending ? editor.resolve.variables ?? null : null}
        error={editor.resolve.isError ? editor.resolve.error.message : null}
        onApplyMine={() => editor.resolve.mutate("mine", { onSuccess: () => { setSheet(null); showToast("Ваши изменения сохранены", { tone: "success" }); } })}
        onTakeTheirs={() => editor.resolve.mutate("theirs", { onSuccess: () => { setSheet(null); showToast("Загружена актуальная версия"); } })}
        onClose={() => setSheet(null)}
      />
      <Sheet open={sheet === "preview"} onClose={() => setSheet(null)} title="Как увидит гость">
        {preview}
        {point.current_published_version_id && <Link className="cabinet-inline-link" to={`/r/${point.public_id}`}>Посмотреть как гость</Link>}
      </Sheet>
      <PublishSheet
        open={sheet === "publish"}
        menu={menu}
        points={venuePoints}
        draftRevision={editor.revision}
        onClose={() => setSheet(null)}
        onPublish={() => { if (publish.isPending) return; setSheet(null); publish.mutate(); }}
        onFix={(problem) => fixProblem(problem.item_key)}
      />
      <MenuCheckSheet open={sheet === "check"} menuId={menu.id} onClose={() => setSheet(null)} onOpenItem={fixProblem} />
      <HistorySheet
        open={sheet === "history"}
        menu={menu}
        draftRevision={editor.revision}
        canRestore={status === "saved"}
        onClose={() => setSheet(null)}
        onRestored={(draft, version) => {
          editor.adopt(draft);
          setSheet(null);
          haptics.notify("success");
          void queryClient.invalidateQueries({ queryKey: ["venue-menus"] });
          showToast(`Версия ${version} в черновике — опубликуйте, чтобы гости её увидели`, { tone: "success" });
        }}
      />
      {sheet === "ai" && primary && (
        <AiMenuComposer
          restaurantId={point.id}
          revision={editor.revision}
          onClose={() => setSheet(null)}
          onApplied={(result) => {
            editor.adopt({ ...result, menu_id: menuId! });
            setSheet(null);
          }}
        />
      )}
    </div>
  );
}
