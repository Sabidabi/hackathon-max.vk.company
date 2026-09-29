import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CloudUpload, History, MapPin, Minus, PencilLine, Plus, RotateCcw } from "lucide-react";
import { useState } from "react";

import type { Restaurant } from "../../../api/restaurants";
import {
  diffMenuVersions,
  fetchPublishCheck,
  listMenuVersions,
  restoreMenuVersion,
  type LibraryDraft,
  type MenuDiff,
  type MenuSummary,
  type PublishProblem,
} from "../../../api/venues";
import { Button, EmptyState, Sheet, Skeleton } from "../../../design";

const FIELD_LABELS: Record<string, string> = {
  name: "название",
  price_minor: "цена",
  is_available: "наличие",
  description: "описание",
  weight_text: "вес/объём",
  ingredients: "состав",
  allergens: "аллергены",
  image_url: "фото",
  configuration: "размеры и добавки",
};

const LIST_LIMIT = 6;

function money(value: unknown): string | null {
  return typeof value === "number" ? `${(value / 100).toLocaleString("ru-RU")} ₽` : null;
}

function changeText(change: { field: string; before: unknown; after: unknown }): string {
  if (change.field === "price_minor") return `цена ${money(change.before) ?? "—"} → ${money(change.after) ?? "—"}`;
  if (change.field === "is_available") return change.after ? "снова в наличии" : "скрыта";
  return FIELD_LABELS[change.field] ?? change.field;
}

/** «Что изменится»: added, changed and removed positions from the server diff. */
export function DiffList({ diff }: { diff: MenuDiff }) {
  if (!diff.total_changes && !diff.sections_added.length && !diff.sections_removed.length) {
    return <p className="cabinet-muted">Изменений нет — гости видят то же, что в черновике.</p>;
  }
  const groups = [
    { key: "added", title: "Новые", icon: <Plus size={16} />, rows: diff.added.map((item) => ({ key: item.item_key, name: item.name, note: item.section })) },
    { key: "changed", title: "Изменены", icon: <PencilLine size={16} />, rows: diff.changed.map((item) => ({ key: item.item_key, name: item.name, note: item.changes.map(changeText).join(", ") })) },
    { key: "removed", title: "Убраны", icon: <Minus size={16} />, rows: diff.removed.map((item) => ({ key: item.item_key, name: item.name, note: item.section })) },
  ].filter((group) => group.rows.length);
  return (
    <div className="publish-diff">
      {groups.map((group) => (
        <section key={group.key} className={`publish-diff__group publish-diff__group--${group.key}`}>
          <h3><span aria-hidden="true">{group.icon}</span>{group.title} · {group.rows.length}</h3>
          <ul>
            {group.rows.slice(0, LIST_LIMIT).map((row) => (
              <li key={row.key}><strong>{row.name}</strong><small>{row.note}</small></li>
            ))}
            {group.rows.length > LIST_LIMIT && <li className="publish-diff__more">и ещё {group.rows.length - LIST_LIMIT}</li>}
          </ul>
        </section>
      ))}
      {diff.sections_removed.length > 0 && <p className="cabinet-muted">Разделы убраны: {diff.sections_removed.join(", ")}</p>}
    </div>
  );
}

/**
 * «Опубликовать изменения»: the server checks the draft
 * and says what changes for guests; blocking problems link to the position; the points that
 * get the new version are confirmed here.
 */
export function PublishSheet({ open, menu, points, draftRevision, onClose, onPublish, onFix }: {
  open: boolean;
  menu: MenuSummary;
  points: Restaurant[];
  /** The draft revision this device has saved: the check must describe exactly it. */
  draftRevision: string;
  onClose: () => void;
  onPublish: () => void;
  onFix: (problem: PublishProblem) => void;
}) {
  const check = useQuery({
    queryKey: ["publish-check", menu.id, draftRevision],
    queryFn: () => fetchPublishCheck(menu.id),
    enabled: open,
    staleTime: 0,
  });
  const targets = points.filter((point) => menu.point_ids.includes(point.id));
  const problems = check.data?.problems ?? [];
  const stale = Boolean(check.data && check.data.revision !== draftRevision);
  const ready = check.isSuccess && !problems.length && !stale && targets.length > 0;
  const label = targets.length > 1 ? `Опубликовать в ${targets.length} точках` : "Опубликовать";
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Что изменится"
      footer={<Button fullWidth icon={<CloudUpload size={20} />} disabled={!ready} onClick={onPublish}>{label}</Button>}
    >
      {check.isPending && (
        <div className="publish-skeleton" aria-busy="true" aria-label="Проверяем меню">
          <Skeleton width="45%" height={20} />
          {[0, 1, 2].map((row) => <Skeleton key={row} height={44} radius="control" />)}
        </div>
      )}
      {check.isError && (
        <EmptyState icon={<AlertTriangle size={28} />} tone="danger" title="Не удалось проверить меню" action={<Button variant="secondary" onClick={() => check.refetch()}>Повторить</Button>}>
          {check.error.message}
        </EmptyState>
      )}
      {check.isSuccess && (
        <>
          {problems.length > 0 && (
            <section className="publish-problems" role="alert" aria-labelledby="publish-problems-title">
              <h3 id="publish-problems-title"><AlertTriangle size={18} aria-hidden="true" />Исправьте перед публикацией · {problems.length}</h3>
              <ul>
                {problems.slice(0, 20).map((problem, index) => (
                  <li key={`${problem.item_key ?? "menu"}-${problem.code}-${index}`}>
                    {problem.item_name
                      ? <span className="publish-problems__text"><strong>{problem.item_name}</strong><small>{problem.code === "no_price" ? "Нет цены" : problem.message.replace(`«${problem.item_name}»: `, "")}</small></span>
                      : <span className="publish-problems__text">{problem.message}</span>}
                    {problem.item_key && <Button variant="ghost" onClick={() => onFix(problem)}>Исправить</Button>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {stale && <p className="cabinet-muted" role="status">Черновик ещё сохраняется — проверим снова через секунду.</p>}
          {menu.published_version
            ? <DiffList diff={check.data.diff} />
            : <p className="publish-first">Первая публикация: гости увидят {check.data.diff.added.length} поз. в {check.data.diff.sections_added.length || 1} разд.</p>}
          <section className="publish-targets" aria-label="Точки">
            <h3>Гости увидят сразу в точках</h3>
            <ul className="menu-publish-points">
              {targets.map((point) => <li key={point.id}><MapPin size={18} aria-hidden="true" />{point.name}</li>)}
            </ul>
          </section>
        </>
      )}
    </Sheet>
  );
}

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "";
}

/**
 * «История версий»: author, date and what changed;
 * «Вернуть эту версию» only rewrites the draft — guests see it after the next publication.
 */
export function HistorySheet({ open, menu, draftRevision, canRestore, onClose, onRestored }: {
  open: boolean;
  menu: MenuSummary;
  draftRevision: string;
  /** Local edits are saved first; restoring over unsaved edits would lose them. */
  canRestore: boolean;
  onClose: () => void;
  onRestored: (draft: LibraryDraft, version: number) => void;
}) {
  const versions = useQuery({ queryKey: ["menu-versions", menu.id, menu.published_version], queryFn: () => listMenuVersions(menu.id), enabled: open });
  const [expanded, setExpanded] = useState<number | null>(null);
  const list = versions.data ?? [];
  const previous = (version: number) => list.find((entry) => entry.version < version)?.version ?? null;
  const diff = useQuery({
    queryKey: ["menu-version-diff", menu.id, expanded],
    queryFn: () => diffMenuVersions(menu.id, previous(expanded!) ?? "draft", expanded!),
    enabled: open && expanded !== null && previous(expanded) !== null,
  });
  const restore = useMutation({
    mutationFn: (version: number) => restoreMenuVersion(menu.id, version, draftRevision),
    onSuccess: (draft, version) => onRestored(draft, version),
  });
  return (
    <Sheet open={open} onClose={onClose} title="История версий">
      {versions.isPending && <div className="publish-skeleton" aria-busy="true" aria-label="Загружаем историю">{[0, 1, 2].map((row) => <Skeleton key={row} height={56} radius="control" />)}</div>}
      {versions.isError && <EmptyState icon={<AlertTriangle size={28} />} tone="danger" title="История не загрузилась" action={<Button variant="secondary" onClick={() => versions.refetch()}>Повторить</Button>}>{versions.error.message}</EmptyState>}
      {versions.isSuccess && !list.length && <EmptyState icon={<History size={28} />} title="Публикаций ещё нет">Каждая публикация сохранится здесь — к ней можно будет вернуться.</EmptyState>}
      {restore.isError && <p className="cabinet-error" role="alert">{restore.error.message}</p>}
      <ul className="history-list">
        {list.map((entry) => (
          <li key={entry.version_id} className="history-list__item">
            <button type="button" className="history-list__row" aria-expanded={expanded === entry.version} onClick={() => setExpanded((current) => (current === entry.version ? null : entry.version))}>
              <span className="history-list__text">
                <strong>Версия {entry.version}{entry.is_current ? " · у гостей" : ""}</strong>
                <small>{entry.author.display_name} · {when(entry.published_at)} · {entry.item_count} поз.</small>
              </span>
            </button>
            {expanded === entry.version && (
              <div className="history-list__details">
                {previous(entry.version) === null
                  ? <p className="cabinet-muted">Первая публикация меню.</p>
                  : diff.isPending ? <Skeleton height={40} radius="control" /> : diff.data ? <DiffList diff={diff.data.diff} /> : null}
                {!entry.is_current && (
                  <Button variant="secondary" icon={<RotateCcw size={18} />} loading={restore.isPending && restore.variables === entry.version} disabled={!canRestore} onClick={() => restore.mutate(entry.version)}>
                    Вернуть эту версию
                  </Button>
                )}
                {!entry.is_current && !canRestore && <p className="cabinet-muted">Дождитесь сохранения черновика.</p>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
