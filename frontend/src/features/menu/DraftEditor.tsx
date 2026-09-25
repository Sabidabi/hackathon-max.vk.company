import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  draftPayload,
  copyMenuToDraft,
  emptyConfiguration,
  fetchMenuLibrary,
  fetchMenuLinks,
  fetchDraftMenu,
  type MenuItem,
  type MenuSection,
  publishMenu,
  saveDraftMenu,
  setBulkAvailability,
  uploadMenuMedia,
} from "../../api/menu";

import { ArrowUp, ArrowDown, Plus, Trash2, Pencil, Search, Eye, Coffee, Check, CloudUpload, EllipsisVertical, Sparkles, Library, Store } from "lucide-react";
import { Help } from "../../components/Help";
import { AiMenuComposer } from "./AiMenuComposer";
import { ItemDialog } from "./ItemDialog";
import { configurationError, displayPrice } from "./configuration";
import { MenuPreview } from "./MenuPreview";

const MAX_MENU_IMAGE_BYTES = 8 * 1024 * 1024;
const MENU_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

const newItem = (): MenuItem => ({
  configuration: emptyConfiguration(),
  id: crypto.randomUUID(),
  name: "Новое блюдо",
  description: null,
  image_url: null,
  price_minor: 0,
  currency: "RUB",
  weight_text: null,
  ingredients: null,
  allergens: [],
  is_available: true,
  source_confidence: null,
});

const newSection = (): MenuSection => ({
  id: crypto.randomUUID(),
  name: "Новый раздел",
  items: [],
});

function move<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

interface DraftEditorProps {
  restaurantId: string;
  publicId: string;
  isPublished: boolean;
  canPublish: boolean;
  isOwner: boolean;
  points: { id: string; name: string; role: string }[];
  onUnsavedChange?: (unsaved: boolean) => void;
}

export function DraftEditor({ restaurantId, publicId, isPublished, canPublish, isOwner, points, onUnsavedChange }: DraftEditorProps) {
  const queryClient = useQueryClient();
  const [sections, setSections] = useState<MenuSection[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [revision, setRevision] = useState("");
  const dirtyRef = useRef(false);
  const [preview, setPreview] = useState(false);
  const [selected, setSelected] = useState<{ sectionId: string; itemId: string } | null>(null);
  const [search, setSearch] = useState("");
  const [showAiComposer, setShowAiComposer] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [bulkItem, setBulkItem] = useState<{ itemId: string; name: string; available: boolean } | null>(null);
  const [bulkTargets, setBulkTargets] = useState<string[]>([restaurantId]);
  const ownRevision = useRef("");
  const draft = useQuery({
    queryKey: ["draft-menu", restaurantId],
    queryFn: () => fetchDraftMenu(restaurantId),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const links = useQuery({
    queryKey: ["menu-links", restaurantId],
    queryFn: () => fetchMenuLinks(restaurantId),
  });
  const library = useQuery({
    queryKey: ["menu-library"],
    queryFn: fetchMenuLibrary,
    enabled: isOwner && showLibrary,
  });
  const copy = useMutation({
    mutationFn: (sourceVersionId: string) => copyMenuToDraft(restaurantId, sourceVersionId, revision),
    onSuccess: (result) => {
      ownRevision.current = result.revision;
      queryClient.setQueryData(["draft-menu", restaurantId], result);
      setSections(result.sections);
      setRevision(result.revision);
      setSavedSnapshot(JSON.stringify(draftPayload(result.sections)));
      setSelected(null);
      setShowLibrary(false);
    },
  });
  const bulk = useMutation({
    mutationFn: () => setBulkAvailability(restaurantId, bulkItem!.itemId, revision, bulkItem!.available, bulkTargets),
    onSuccess: async () => {
      const updated = await fetchDraftMenu(restaurantId);
      ownRevision.current = updated.revision;
      queryClient.setQueryData(["draft-menu", restaurantId], updated);
      setSections(updated.sections);
      setSavedSnapshot(JSON.stringify(draftPayload(updated.sections)));
      setRevision(updated.revision);
      for (const target of bulkTargets.filter((id) => id !== restaurantId)) void queryClient.invalidateQueries({ queryKey: ["draft-menu", target] });
      setBulkItem(null);
    },
  });

  const saveDraft = useMutation({
    mutationFn: (nextSections: MenuSection[]) => saveDraftMenu(restaurantId, nextSections, revision),
    onSuccess: (result, sentSections) => {
      ownRevision.current = result.revision;
      queryClient.setQueryData(["draft-menu", restaurantId], result);
      setRevision(result.revision);
      setSavedSnapshot(JSON.stringify(draftPayload(sentSections)));
    },
  });
  const publication = useMutation({
    mutationFn: () => publishMenu(restaurantId, revision),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["restaurants"] });
      void queryClient.invalidateQueries({ queryKey: ["public-menu", publicId] });
      void queryClient.invalidateQueries({ queryKey: ["menu-library"] });
    },
  });
  const mediaUpload = useMutation({
    mutationFn: ({ file }: { sectionId: string; itemId: string; file: File }) => {
      if (!MENU_IMAGE_TYPES.has(file.type)) {
        throw new Error("Выберите изображение в формате JPG или PNG");
      }
      if (file.size > MAX_MENU_IMAGE_BYTES) {
        throw new Error("Фотография должна быть не больше 8 МБ");
      }
      return uploadMenuMedia(restaurantId, file);
    },
    onSuccess: (media, variables) => {
      updateItem(variables.sectionId, variables.itemId, { image_url: media.url });
    },
  });

  useEffect(() => {
    if (!draft.data || dirtyRef.current || draft.data.revision === ownRevision.current) return;
    setSections(draft.data.sections);
    setSavedSnapshot(JSON.stringify(draftPayload(draft.data.sections)));
    setRevision(draft.data.revision);
    setInitialized(true);
  }, [draft.data]);

  const snapshot = useMemo(() => JSON.stringify(draftPayload(sections)), [sections]);
  const invalid = sections.some(
    (section) =>
      !section.name.trim() ||
      section.items.some((item) => !item.name.trim() || configurationError(item.configuration ?? emptyConfiguration()) !== null || !Number.isInteger(item.price_minor) || item.price_minor < 0 || item.price_minor > 100_000_000),
  );
  const dirty = initialized && snapshot !== savedSnapshot;

  useEffect(() => {
    onUnsavedChange?.(dirty || saveDraft.isPending);
  }, [dirty, saveDraft.isPending, onUnsavedChange]);
  useEffect(() => () => onUnsavedChange?.(false), [onUnsavedChange]);

  dirtyRef.current = dirty;

  useEffect(() => {
    const preventLoss = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, []);

  useEffect(() => {
    if (!initialized || invalid || !dirty || saveDraft.isPending || saveDraft.isError) return;
    const timer = window.setTimeout(() => {
      const sentSnapshot = snapshot;
      saveDraft.mutate(sections, {
        onSuccess: () => {
          setSavedSnapshot(sentSnapshot);
        },
      });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [dirty, initialized, invalid, saveDraft, sections, snapshot]);

  function updateSection(sectionId: string, patch: Partial<MenuSection>) {
    publication.reset();
    setSections((current) =>
      current.map((section) => (section.id === sectionId ? { ...section, ...patch } : section)),
    );
  }

  function updateItem(sectionId: string, itemId: string, patch: Partial<MenuItem>) {
    publication.reset();
    setSections((current) =>
      current.map((section) =>
        section.id === sectionId
          ? {
              ...section,
              items: section.items.map((item) =>
                item.id === itemId ? { ...item, ...patch } : item,
              ),
            }
          : section,
      ),
    );
  }

  if (draft.isPending) {
    return <section className="menu-editor menu-editor--loading">Загружаем черновик…</section>;
  }
  if (draft.isError) {
    return (
      <section className="menu-editor">
        <p className="form-error">{draft.error.message}</p>
        <button type="button" className="button-quiet" onClick={() => draft.refetch()}>
          Повторить
        </button>
      </section>
    );
  }

  const itemCount = sections.reduce((sum, section) => sum + section.items.length, 0);
  const selectedItem = selected ? sections.find((section) => section.id === selected.sectionId)?.items.find((item) => item.id === selected.itemId) : undefined;
  const canSubmit = canPublish && sections.some((section) => section.items.some((item) => item.is_available)) && !invalid && !dirty && !saveDraft.isPending && !mediaUpload.isPending && !publication.isPending;
  const publicUrl = links.data?.public_menu_url ?? `${window.location.origin}/r/${publicId}`;
  return <section className="menu-editor">
    <div className="workspace-title">
      <div><h2>Меню <span className="count-badge">{itemCount}</span></h2><span className={`save-state ${saveDraft.isError || invalid ? "save-state--error" : ""}`} role="status">{invalid ? "Проверьте поля" : saveDraft.isError ? "Не сохранено" : saveDraft.isPending || dirty ? "Сохраняем…" : <><Check size={13} />Сохранено</>}</span></div>
      <div className="header-actions"><Help label="О публикации меню">Изменения сохраняются в черновик. После публикации их увидят гости, включая изменения стоп-листа.</Help>{isOwner && <button type="button" className="button-quiet" aria-label="Библиотека меню" onClick={() => setShowLibrary((value) => !value)}><Library size={17} /><span className="desktop-label">Библиотека</span></button>}<button type="button" className="button-quiet" aria-label="Добавить позиции с ИИ" disabled={dirty || invalid || saveDraft.isPending} onClick={() => setShowAiComposer(true)}><Sparkles size={17} /><span className="desktop-label">Добавить с ИИ</span></button><button type="button" className="button-quiet" aria-label="Предпросмотр меню" onClick={() => setPreview(!preview)}><Eye size={17} /><span className="desktop-label">Просмотр</span></button><button type="button" disabled={!canSubmit} onClick={() => publication.mutate()}><CloudUpload size={17} />{publication.isPending ? "Публикуем…" : "Опубликовать"}</button></div>
    </div>
    {showLibrary && isOwner && <section className="menu-library"><div className="subsection-heading"><h3>Опубликованные меню</h3><button className="button-quiet" onClick={() => setShowLibrary(false)}>Закрыть</button></div><p className="muted">Выберите сохранённую версию любой своей точки. Копия заменит только черновик этой точки.</p>{library.isPending && <p className="muted">Загружаем…</p>}{library.isError && <p className="form-error">{library.error.message}</p>}{library.data?.length === 0 && <p className="muted">Опубликуйте первое меню, чтобы использовать его как шаблон.</p>}{library.data?.map((entry) => <div className="menu-library-row" key={entry.version_id}><span><strong>{entry.restaurant_name}</strong><small>Версия {entry.version}{entry.restaurant_id === restaurantId ? " · эта точка" : ""}</small></span><button className="button-quiet" disabled={dirty || invalid || saveDraft.isPending || copy.isPending} onClick={() => { if (window.confirm("Заменить черновик выбранной версией? Опубликованное меню не изменится.")) copy.mutate(entry.version_id); }}>{copy.isPending ? "Копируем…" : entry.restaurant_id === restaurantId ? "Вернуть" : "Скопировать"}</button></div>)}{copy.isError && <p className="form-error" role="alert">{copy.error.message}</p>}</section>}
    {bulkItem && isOwner && <section className="menu-library"><div className="subsection-heading"><h3>{bulkItem.name}: {bulkItem.available ? "в наличии" : "стоп-лист"}</h3><button type="button" className="button-quiet" onClick={() => setBulkItem(null)}>Закрыть</button></div><p className="muted">Выберите точки с одинаковым названием позиции и раздела. Изменения сохранятся в черновиках; затем опубликуйте меню каждой точки.</p><div className="bulk-point-list">{points.filter((point) => point.role === "owner").map((point) => <label key={point.id}><input type="checkbox" checked={bulkTargets.includes(point.id)} onChange={(event) => setBulkTargets((old) => event.target.checked ? [...old, point.id] : old.filter((id) => id !== point.id))} />{point.name}</label>)}</div><button type="button" disabled={!bulkTargets.length || dirty || saveDraft.isPending || bulk.isPending} onClick={() => bulk.mutate()}>{bulk.isPending ? "Обновляем…" : "Изменить наличие"}</button>{bulk.isError && <p className="form-error" role="alert">{bulk.error.message}</p>}</section>}
    <div className="menu-toolbar"><label className="search-field"><Search size={17} /><input type="search" aria-label="Поиск позиций" placeholder="Найти позицию" value={search} onChange={(event) => setSearch(event.target.value)} /></label><button type="button" className="button-quiet" disabled={sections.length >= 100 || publication.isPending} onClick={() => setSections((current) => [...current, newSection()])}><Plus size={16} />Раздел</button></div>
    {preview && <div className="draft-preview"><div className="subsection-heading"><h3>Предпросмотр</h3><button className="button-quiet" onClick={() => setPreview(false)}>Закрыть</button></div><MenuPreview sections={sections} /></div>}
    {!sections.length && <div className="menu-empty"><Coffee size={40} strokeWidth={1.3} /><h3>Начните с первого раздела</h3><button className="button-quiet" onClick={() => setSections([newSection()])}><Plus size={16} />Добавить раздел</button></div>}
    <fieldset className="editor-fields" disabled={publication.isPending}>
      {sections.map((section, sectionIndex) => <section className="catalog-section" key={section.id}>
        <div className="category-heading"><input aria-label="Название раздела" maxLength={200} value={section.name} onChange={(event) => updateSection(section.id, { name: event.target.value })} /><span className="count-badge">{section.items.length}</span><div className="row-actions"><button className="icon-button" aria-label={`Поднять раздел ${section.name}`} disabled={sectionIndex === 0} onClick={() => setSections((current) => move(current, sectionIndex, -1))}><ArrowUp size={15} /></button><button className="icon-button" aria-label={`Опустить раздел ${section.name}`} disabled={sectionIndex === sections.length - 1} onClick={() => setSections((current) => move(current, sectionIndex, 1))}><ArrowDown size={15} /></button><button className="icon-button danger" aria-label={`Удалить раздел ${section.name}`} onClick={() => { if (window.confirm(`Удалить «${section.name}» со всеми позициями?`)) setSections((current) => current.filter((s) => s.id !== section.id)); }}><Trash2 size={15} /></button></div></div>
        <div className="catalog-items">
          {section.items.map((item, itemIndex) => !`${item.name} ${item.description ?? ""}`.toLocaleLowerCase("ru").includes(search.toLocaleLowerCase("ru")) ? null : <article className={`catalog-row ${item.is_available ? "" : "catalog-row--stopped"}`} key={item.id}>
            <button className="dish-summary" onClick={() => setSelected({ sectionId: section.id, itemId: item.id })}>{item.image_url ? <img src={item.image_url} alt="" /> : <span className="dish-icon"><Coffee size={23} strokeWidth={1.4} /></span>}<span><strong>{item.name || "Без названия"}</strong><small>{[item.weight_text, item.configuration?.variants.length ? `${item.configuration.variants.length} размера` : null, item.configuration?.modifier_groups.length ? "Добавки" : null].filter(Boolean).join(" · ") || "Без вариантов"}</small></span></button>
            <strong className="catalog-price">{displayPrice(item)}</strong>
            <label className="availability-switch" title={item.is_available ? "В наличии" : "Стоп-лист"}><input type="checkbox" aria-label={`В наличии: ${item.name}`} checked={item.is_available} onChange={(event) => updateItem(section.id, item.id, { is_available: event.target.checked })} /><span /></label>
            <div className="row-actions"><button className="icon-button" aria-label={`Редактировать ${item.name}`} onClick={() => setSelected({ sectionId: section.id, itemId: item.id })}><Pencil size={16} /></button><details className="row-menu"><summary aria-label={`Действия: ${item.name}`}><EllipsisVertical size={16} /></summary><div><button disabled={itemIndex === 0} onClick={() => updateSection(section.id, { items: move(section.items, itemIndex, -1) })}><ArrowUp size={14} />Выше</button><button disabled={itemIndex === section.items.length - 1} onClick={() => updateSection(section.id, { items: move(section.items, itemIndex, 1) })}><ArrowDown size={14} />Ниже</button>{isOwner && <button onClick={() => { setBulkTargets([restaurantId]); bulk.reset(); setBulkItem({ itemId: item.id, name: item.name, available: !item.is_available }); }}><Store size={14} />Наличие по точкам</button>}<button className="danger" onClick={() => { if (window.confirm(`Удалить «${item.name}»?`)) updateSection(section.id, { items: section.items.filter((i) => i.id !== item.id) }); }}><Trash2 size={14} />Удалить</button></div></details></div>
          </article>)}
        </div>
        <button className="add-item-button" disabled={section.items.length >= 300 || itemCount >= 1000} onClick={() => { const item = newItem(); updateSection(section.id, { items: [...section.items, item] }); setSelected({ sectionId: section.id, itemId: item.id }); }}><Plus size={16} />Позиция</button>
      </section>)}
    </fieldset>
    {selected && selectedItem && <ItemDialog item={selectedItem} onChange={(patch) => updateItem(selected.sectionId, selected.itemId, patch)} onClose={() => setSelected(null)} onUpload={(file) => mediaUpload.mutate({ ...selected, file })} uploading={mediaUpload.isPending} uploadError={mediaUpload.isError ? mediaUpload.error.message : undefined} saving={dirty || saveDraft.isPending} />}
    {showAiComposer && <AiMenuComposer restaurantId={restaurantId} revision={revision} onClose={() => setShowAiComposer(false)} onApplied={(result) => { ownRevision.current = result.revision; queryClient.setQueryData(["draft-menu", restaurantId], result); setSections(result.sections); setRevision(result.revision); setSavedSnapshot(JSON.stringify(draftPayload(result.sections))); setSelected(null); }} />}
    {saveDraft.isError && <div className="save-error" role="alert"><p className="form-error">{saveDraft.error.message}</p><div className="header-actions"><button className="button-quiet" onClick={() => saveDraft.reset()}>Повторить</button><button className="button-quiet" onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(draftPayload(sections), null, 2)], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = "menu-draft-backup.json"; a.click(); URL.revokeObjectURL(url); }}>Скачать копию</button><button className="button-quiet" onClick={async () => { if (!window.confirm("Заменить локальные правки актуальным черновиком? Сначала скачайте копию, если она нужна.")) return; const result = await draft.refetch(); if (result.data && !result.isError) { setSections(result.data.sections); setRevision(result.data.revision); setSavedSnapshot(JSON.stringify(draftPayload(result.data.sections))); setSelected(null); saveDraft.reset(); } }}>Обновить черновик</button></div></div>}
    {!canPublish && <p className="muted">Публикация доступна владельцу и управляющему.</p>}
    {publication.isError && <p className="form-error" role="alert">{publication.error.message}</p>}
    {(publication.isSuccess || isPublished) && <div className="publication-line"><Check size={16} /><span>{publication.isSuccess ? `Версия ${publication.data.version} опубликована` : "Меню опубликовано"}</span><a href={publicUrl} target="_blank" rel="noreferrer">Открыть</a></div>}
  </section>;
}
