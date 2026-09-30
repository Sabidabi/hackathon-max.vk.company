import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ImagePlus, Moon, Palette, Sun, Wand2, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import {
  fetchSiteDraft,
  publishSite,
  saveSiteDraft,
  uploadSiteMedia,
  type SiteConfig,
  type SiteImageKind,
  type SiteTemplate,
} from "../../../api/site";
import { fetchLibraryDraft, venueKeys } from "../../../api/venues";
import { Button, EmptyState, Skeleton, TextInput } from "../../../design";
import { showToast } from "../../../design/toast";
import { haptics } from "../../../max";
import type { CabinetContext } from "../shell/CabinetShell";
import { contrastIssues, fixIssue, type ThemeColors } from "./contrast";
import { ThemePreview } from "./ThemePreview";
import { TileSettings } from "./TileSettings";
import "./design.css";

interface ThemePreset {
  id: SiteTemplate;
  name: string;
  light: ThemeColors & { icon_color: string };
  dark: ThemeColors & { icon_color: string };
}

/** Venue themes (P1-DOC-3 «Темы меню заведения»): each with a light and a dark variant. */
export const THEMES: ThemePreset[] = [
  {
    id: "modern",
    name: "Минимал",
    light: { primary_color: "#171717", background_color: "#F3F3EF", surface_color: "#FFFFFF", text_color: "#171717", icon_color: "#FF5C35" },
    dark: { primary_color: "#FF6B47", background_color: "#0E1011", surface_color: "#191C1D", text_color: "#F4F5EF", icon_color: "#FF6B47" },
  },
  {
    id: "classic",
    name: "Бистро",
    light: { primary_color: "#234738", background_color: "#ECEFE6", surface_color: "#FFFEF8", text_color: "#17231E", icon_color: "#C66A3D" },
    dark: { primary_color: "#E0B56C", background_color: "#101412", surface_color: "#1A201D", text_color: "#F2EFE6", icon_color: "#E0B56C" },
  },
  {
    id: "cafe",
    name: "Поп",
    light: { primary_color: "#D93A1F", background_color: "#FFF3E7", surface_color: "#FFFCF7", text_color: "#241B17", icon_color: "#F04B2F" },
    dark: { primary_color: "#FF8064", background_color: "#15100E", surface_color: "#221A17", text_color: "#FFF3E7", icon_color: "#FF8064" },
  },
  {
    id: "noir",
    name: "Ночь",
    light: { primary_color: "#171717", background_color: "#F3F3EF", surface_color: "#FFFFFF", text_color: "#171717", icon_color: "#5A6B00" },
    dark: { primary_color: "#D8FF52", background_color: "#0E1011", surface_color: "#191C1D", text_color: "#F4F5EF", icon_color: "#D8FF52" },
  },
];

const COLOR_FIELDS: Array<{ key: keyof ThemeColors; label: string }> = [
  { key: "primary_color", label: "Акцент" },
  { key: "text_color", label: "Текст" },
  { key: "surface_color", label: "Карточки" },
  { key: "background_color", label: "Фон" },
];

const AUTOSAVE_MS = 800;

function MediaSlot({ kind, label, url, busy, onUpload, onRemove }: {
  kind: SiteImageKind;
  label: string;
  url: string | null;
  busy: boolean;
  onUpload: (kind: SiteImageKind, file: File) => void;
  onRemove: () => void;
}) {
  return (
    <div className={`design-media design-media--${kind}`}>
      <label className="design-media__pick">
        <input type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) onUpload(kind, file); event.target.value = ""; }} />
        {url ? <img src={url} alt="" /> : <ImagePlus size={22} aria-hidden="true" />}
        <span>{url ? `Заменить: ${label.toLocaleLowerCase("ru")}` : label}</span>
      </label>
      {url && <button type="button" className="design-media__remove" aria-label={`Убрать ${label.toLocaleLowerCase("ru")}`} onClick={onRemove}><X size={16} /></button>}
    </div>
  );
}

/**
 * «Оформление» (P1-DOC-7, P1-DOC-3): venue theme, light/dark, colours with a WCAG check and
 * «Исправить», cover and logo, text size; the live preview shows the draft through the guest
 * menu styles. Changes autosave to the draft; guests see them after «Опубликовать оформление».
 */
export function DesignSection({ context }: { context: CabinetContext }) {
  const { point } = context;
  const queryClient = useQueryClient();
  const site = useQuery({ queryKey: ["site-draft", point.id], queryFn: () => fetchSiteDraft(point.id), retry: false, refetchOnWindowFocus: false });
  const menu = useQuery({
    queryKey: venueKeys.draft(point.menu_id ?? "none"),
    queryFn: () => fetchLibraryDraft(point.menu_id!),
    enabled: Boolean(point.menu_id),
  });
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [saved, setSaved] = useState("");
  const revision = useRef("");
  const [publishState, setPublishState] = useState<"idle" | "progress" | "success">("idle");

  useEffect(() => {
    if (site.data && (config === null || (JSON.stringify(config) === saved && site.data.revision !== revision.current))) {
      setConfig(site.data.config);
      setSaved(JSON.stringify(site.data.config));
      revision.current = site.data.revision;
    }
  }, [config, saved, site.data]);

  const dirty = config !== null && JSON.stringify(config) !== saved;
  const save = useMutation({
    mutationFn: (next: SiteConfig) => saveSiteDraft(point.id, next, revision.current),
    onSuccess: (draft, sent) => {
      revision.current = draft.revision;
      setSaved(JSON.stringify(sent));
      queryClient.setQueryData(["site-draft", point.id], draft);
    },
  });
  // Autosave the draft shortly after the last change.
  useEffect(() => {
    if (!dirty || !config || save.isPending || save.isError) return;
    const timer = window.setTimeout(() => save.mutate(config), AUTOSAVE_MS);
    return () => window.clearTimeout(timer);
  }, [config, dirty, save]);

  const upload = useMutation({
    mutationFn: ({ kind, file }: { kind: SiteImageKind; file: File }) => {
      return uploadSiteMedia(point.id, kind, file);
    },
    onSuccess: (media, { kind }) => patch(kind === "logo" ? { logo_url: media.url } : { cover_url: media.url }),
    onError: () => haptics.notify("error"),
  });

  const publish = useMutation({
    mutationFn: async () => {
      let current = revision.current;
      if (dirty && config) {
        const draft = await saveSiteDraft(point.id, config, current);
        revision.current = current = draft.revision;
        setSaved(JSON.stringify(config));
      }
      return publishSite(point.id, current);
    },
    onMutate: () => setPublishState("progress"),
    onSuccess: () => {
      haptics.notify("success");
      setPublishState("success");
      showToast("Оформление опубликовано", { tone: "success" });
      window.setTimeout(() => setPublishState("idle"), 1_200);
      void queryClient.invalidateQueries({ queryKey: ["site-draft", point.id] });
      void queryClient.invalidateQueries({ queryKey: ["public-menu"] });
    },
    onError: () => {
      haptics.notify("error");
      setPublishState("idle");
    },
  });

  function patch(next: Partial<SiteConfig>) {
    setConfig((current) => (current ? { ...current, ...next } : current));
    save.reset();
  }

  if (site.isPending || (!config && !site.isError)) {
    return (
      <div className="design-page" aria-busy="true" aria-label="Загружаем оформление">
        <Skeleton width={180} height={28} />
        <div className="design-themes">{THEMES.map((theme) => <Skeleton key={theme.id} height={96} radius="control" />)}</div>
      </div>
    );
  }
  if (site.isError || !config) {
    return (
      <EmptyState icon={<AlertTriangle size={28} />} tone="danger" title="Оформление не загрузилось" action={<Button onClick={() => site.refetch()}>Повторить</Button>}>
        {site.error?.message}
      </EmptyState>
    );
  }

  const mode = config.theme_mode;
  const issues = contrastIssues(config);
  const chooseTheme = (theme: ThemePreset, nextMode = mode) => {
    haptics.selection();
    patch({ template: theme.id, theme_mode: nextMode, ...theme[nextMode] });
  };
  const current = THEMES.find((theme) => theme.id === config.template) ?? THEMES[0];
  const fixAll = () => {
    let colors: ThemeColors = config;
    for (const issue of contrastIssues(colors)) colors = fixIssue(colors, issue);
    haptics.notify("success");
    patch({ primary_color: colors.primary_color, text_color: colors.text_color });
  };
  const publishedOnce = Boolean(site.data?.published_version);
  const menuPublished = Boolean(point.current_published_version_id);
  const statusText = save.isError ? "Не сохранилось" : dirty || save.isPending ? "Сохраняем…" : "Черновик сохранён";

  return (
    <div className="design-page">
      <header className="design-header">
        <h1 className="cabinet-title">Оформление</h1>
        <span className={`design-status${save.isError ? " design-status--error" : ""}`} role="status">{statusText}</span>
      </header>
      <div className="design-layout">
        <div className="design-controls">
          {save.isError && (
            <p className="menu-note menu-note--danger" role="alert">
              {save.error.message}
              <button type="button" onClick={() => { void site.refetch().then((result) => { if (result.data) { revision.current = result.data.revision; save.reset(); } }); }}>Повторить</button>
            </p>
          )}

          <section aria-labelledby="design-theme-title" className="design-block">
            <h2 id="design-theme-title">Тема</h2>
            <div className="design-themes" role="radiogroup" aria-label="Тема меню">
              {THEMES.map((theme) => {
                const colors = theme[mode];
                return (
                  <button
                    key={theme.id}
                    type="button"
                    role="radio"
                    aria-checked={config.template === theme.id}
                    className="design-theme"
                    onClick={() => chooseTheme(theme)}
                    style={{ "--t-bg": colors.background_color, "--t-surface": colors.surface_color, "--t-text": colors.text_color, "--t-accent": colors.primary_color } as CSSProperties}
                  >
                    <span className="design-theme__thumb" aria-hidden="true"><i /><i /><b /></span>
                    <span className="design-theme__name">{theme.name}</span>
                  </button>
                );
              })}
            </div>
            <div className="design-mode" role="group" aria-label="Светлая или тёмная">
              <button type="button" aria-pressed={mode === "light"} onClick={() => chooseTheme(current, "light")}><Sun size={18} aria-hidden="true" />Светлая</button>
              <button type="button" aria-pressed={mode === "dark"} onClick={() => chooseTheme(current, "dark")}><Moon size={18} aria-hidden="true" />Тёмная</button>
            </div>
          </section>

          <TileSettings config={config} patch={patch} />

          <section aria-labelledby="design-colors-title" className="design-block">
            <h2 id="design-colors-title">Цвета</h2>
            <div className="design-colors">
              {COLOR_FIELDS.map((field) => (
                <label key={field.key} className="design-color">
                  <input type="color" value={config[field.key]} onChange={(event) => patch({ [field.key]: event.target.value.toUpperCase() } as Partial<SiteConfig>)} />
                  <span><strong>{field.label}</strong><small>{config[field.key].toUpperCase()}</small></span>
                </label>
              ))}
            </div>
            {issues.length > 0 && (
              <div className="design-contrast" role="alert">
                <p><AlertTriangle size={18} aria-hidden="true" /><strong>Гостям будет трудно читать</strong></p>
                <ul>
                  {issues.map((issue) => (
                    <li key={issue.pair}>
                      <span>{issue.label}: {issue.ratio.toFixed(1)}:1, нужно {issue.required}:1</span>
                      <Button variant="ghost" onClick={() => { haptics.selection(); const next = fixIssue(config, issue); patch({ [issue.field]: next[issue.field] } as Partial<SiteConfig>); }}>Исправить</Button>
                    </li>
                  ))}
                </ul>
                {issues.length > 1 && <Button variant="secondary" icon={<Wand2 size={18} />} onClick={fixAll}>Исправить всё</Button>}
              </div>
            )}
          </section>

          <section aria-labelledby="design-media-title" className="design-block">
            <h2 id="design-media-title">Обложка и логотип</h2>
            <div className="design-media-row">
              <MediaSlot kind="cover" label="Обложка" url={config.cover_url} busy={upload.isPending} onUpload={(kind, file) => upload.mutate({ kind, file })} onRemove={() => patch({ cover_url: null })} />
              <MediaSlot kind="logo" label="Логотип" url={config.logo_url} busy={upload.isPending} onUpload={(kind, file) => upload.mutate({ kind, file })} onRemove={() => patch({ logo_url: null })} />
            </div>
            {upload.isError && <p className="cabinet-error" role="alert">{upload.error.message}</p>}
            <p className="cabinet-muted">JPG или PNG. Большие фото уменьшим сами.</p>
          </section>

          <section aria-labelledby="design-text-title" className="design-block">
            <h2 id="design-text-title">Текст</h2>
            <label className="design-scale">
              <span>Размер шрифта</span>
              <input type="range" min="0.9" max="1.15" step="0.05" value={config.font_scale} onChange={(event) => patch({ font_scale: Number(event.target.value) })} />
            </label>
            <TextInput label="Подзаголовок" maxLength={200} placeholder="Кофе и свежая выпечка" value={config.tagline ?? ""} onChange={(event) => patch({ tagline: event.target.value || null })} />
            <TextInput label="Часы работы" maxLength={300} placeholder="Ежедневно 08:00–22:00" value={config.hours ?? ""} onChange={(event) => patch({ hours: event.target.value || null })} />
          </section>
        </div>

        <aside className="design-preview" aria-label="Как увидит гость">
          <p className="menu-phone__label"><Palette size={16} aria-hidden="true" />Как увидит гость</p>
          <ThemePreview config={config} title={point.venue_name ?? point.name} address={point.address ?? null} sections={menu.data?.sections ?? []} />
        </aside>
      </div>

      <div className="menu-publish design-publish" data-toast-avoid role="region" aria-label="Публикация оформления">
        <span className="menu-publish__text">
          {issues.length ? "Исправьте контраст — иначе не опубликовать" : !menuPublished ? "Сначала опубликуйте меню" : publishedOnce ? "Гости увидят оформление после публикации" : "Оформление ещё не видно гостям"}
        </span>
        <Button
          status={publishState}
          disabled={publishState !== "idle" || issues.length > 0 || !menuPublished || save.isError}
          onClick={() => { haptics.impact("light"); publish.mutate(); }}
        >
          Опубликовать оформление
        </Button>
        {publish.isError && <p className="cabinet-error menu-publish__error" role="alert">{publish.error.message}</p>}
      </div>
    </div>
  );
}
