import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image as ImageIcon, Moon, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { fetchDraftMenu } from "../../api/menu";
import { MenuPreview } from "../menu/MenuPreview";
import type { Restaurant } from "../../api/restaurants";
import {
  fetchSiteDraft,
  publishSite,
  saveSiteDraft,
  uploadSiteMedia,
  type SiteBlockKind,
  type SiteConfig,
  type SiteImageKind,
  type SiteTemplate,
} from "../../api/site";
import { SiteLayout } from "./SiteLayout";

const templates: Array<{
  id: SiteTemplate;
  name: string;
  description: string;
  theme: "light" | "dark";
  primary: string;
  background: string;
  surface: string;
  text: string;
  icon: string;
}> = [
  {
    id: "modern",
    name: "Минимал",
    description: "Чистый и нейтральный",
    theme: "light",
    primary: "#171717",
    background: "#F3F3EF",
    surface: "#FFFFFF",
    text: "#171717",
    icon: "#FF5C35",
  },
  {
    id: "classic",
    name: "Бистро",
    description: "Тёплый и редакционный",
    theme: "light",
    primary: "#234738",
    background: "#ECEFE6",
    surface: "#FFFEF8",
    text: "#17231E",
    icon: "#C66A3D",
  },
  {
    id: "cafe",
    name: "Поп",
    description: "Яркий и энергичный",
    theme: "light",
    primary: "#F04B2F",
    background: "#FFF3E7",
    surface: "#FFFCF7",
    text: "#241B17",
    icon: "#F04B2F",
  },
  {
    id: "noir",
    name: "Ночь",
    description: "Контрастный тёмный",
    theme: "dark",
    primary: "#D8FF52",
    background: "#0E1011",
    surface: "#191C1D",
    text: "#F4F5EF",
    icon: "#D8FF52",
  },
];

const blockNames: Record<SiteBlockKind, string> = {
  hero: "Обложка",
  about: "О ресторане",
  menu: "Меню",
  gallery: "Галерея",
  contacts: "Контакты",
};

const MAX_SITE_IMAGE_BYTES = 8 * 1024 * 1024;

export function SiteBuilder({ restaurant }: { restaurant: Restaurant }) {
  const queryClient = useQueryClient();
  const menu = useQuery({ queryKey: ["draft-menu", restaurant.id], queryFn: () => fetchDraftMenu(restaurant.id), refetchOnWindowFocus: false, refetchOnReconnect: false });
  const site = useQuery({
    queryKey: ["site-draft", restaurant.id],
    queryFn: () => fetchSiteDraft(restaurant.id),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const dirtyRef = useRef(false);
  const [revision, setRevision] = useState("");
  const [savedConfig, setSavedConfig] = useState("");
  const [config, setConfig] = useState<SiteConfig | null>(null);

  useEffect(() => {
    if (site.data && !dirtyRef.current) {
      setConfig(site.data.config); setRevision(site.data.revision); setSavedConfig(JSON.stringify(site.data.config));
    }
  }, [site.data]);

  const save = useMutation({
    mutationFn: () => {
      if (!config) throw new Error("Конструктор ещё загружается");
      return saveSiteDraft(restaurant.id, config, revision);
    },
    onSuccess: (draft) => {
      setConfig(draft.config); setRevision(draft.revision); setSavedConfig(JSON.stringify(draft.config));
      queryClient.setQueryData(["site-draft", restaurant.id], draft);
    },
  });
  const publish = useMutation({
    mutationFn: async () => {
      if (!config) throw new Error("Конструктор ещё загружается");
      const saved = await saveSiteDraft(restaurant.id, config, revision);
      setRevision(saved.revision); setSavedConfig(JSON.stringify(saved.config)); setConfig(saved.config);
      return publishSite(restaurant.id, saved.revision);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["site-draft", restaurant.id] });
      void queryClient.invalidateQueries({ queryKey: ["public-menu", restaurant.public_id] });
    },
  });
  const mediaUpload = useMutation({
    mutationFn: ({ kind, file }: { kind: SiteImageKind; file: File }) => {
      if (file.size > MAX_SITE_IMAGE_BYTES) {
        throw new Error("Изображение должно быть не больше 8 МБ");
      }
      return uploadSiteMedia(restaurant.id, kind, file);
    },
    onSuccess: (media, variables) => {
      setConfig((current) => {
        if (!current) return current;
        if (variables.kind === "logo") return { ...current, logo_url: media.url };
        if (variables.kind === "cover") return { ...current, cover_url: media.url };
        if (variables.kind === "background") return { ...current, background_image_url: media.url };
        return {
          ...current,
          gallery_urls: [...current.gallery_urls, media.url].slice(0, 8),
        };
      });
      save.reset();
      publish.reset();
    },
  });

  dirtyRef.current = config !== null && JSON.stringify(config) !== savedConfig;
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);

  function patchConfig(patch: Partial<SiteConfig>) {
    setConfig((current) => (current ? { ...current, ...patch } : current));
    save.reset();
    publish.reset();
  }

  function chooseTemplate(template: (typeof templates)[number]) {
    patchConfig({
      template: template.id,
      theme_mode: template.theme,
      primary_color: template.primary,
      background_color: template.background,
      surface_color: template.surface,
      text_color: template.text,
      icon_color: template.icon,
    });
  }

  function chooseTheme(theme: "light" | "dark") {
    const template = templates.find((item) => item.id === config?.template) ?? templates[0];
    if (theme === "light") {
      patchConfig({
        theme_mode: "light",
        primary_color: template.id === "noir" ? "#171717" : template.primary,
        background_color: template.id === "noir" ? "#F3F3EF" : template.background,
        surface_color: template.id === "noir" ? "#FFFFFF" : template.surface,
        text_color: template.id === "noir" ? "#171717" : template.text,
        icon_color: template.id === "noir" ? "#FF5C35" : template.icon,
      });
      return;
    }
    const darkAccents: Record<SiteTemplate, string> = {
      modern: "#FF6B47",
      classic: "#E0B56C",
      cafe: "#FF8064",
      noir: "#D8FF52",
    };
    patchConfig({
      theme_mode: "dark",
      primary_color: darkAccents[template.id],
      background_color: "#0E1011",
      surface_color: "#191C1D",
      text_color: "#F4F5EF",
      icon_color: darkAccents[template.id],
    });
  }

  function moveBlock(index: number, direction: -1 | 1) {
    if (!config) return;
    const target = index + direction;
    if (target < 0 || target >= config.blocks.length) return;
    const blocks = [...config.blocks];
    [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
    patchConfig({ blocks });
  }

  if (site.isError) {
    return <p className="form-error">{site.error.message}</p>;
  }
  if (site.isPending || !config) {
    return <div className="site-builder site-builder--loading">Загружаем конструктор…</div>;
  }

  const mutationError =
    save.error?.message ?? publish.error?.message ?? mediaUpload.error?.message;
  return (
    <details className="site-builder" open>
      <summary>
        <div>
          <h2>Оформление</h2>
        </div>
        <span className="site-version">
          {site.data.published_version
            ? `Версия ${site.data.published_version}`
            : "Черновик"}
        </span>
      </summary>

      <div className="site-builder-grid">
        <fieldset className="site-builder-controls editor-fields" disabled={save.isPending || publish.isPending}>
          <div className="site-control-group">
            <strong>Шаблон</strong>
            <div className="site-template-picker">
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className={config.template === template.id ? "is-active" : ""}
                  onClick={() => chooseTemplate(template)}
                >
                  <span
                    className="site-template-swatch"
                    style={{
                      "--swatch-primary": template.primary,
                      "--swatch-background": template.background,
                      "--swatch-surface": template.surface,
                    } as CSSProperties}
                    aria-hidden="true"
                  >
                    <i /><i /><i />
                  </span>
                  <span className="site-template-copy"><strong>{template.name}</strong><small>{template.description}</small></span>
                </button>
              ))}
            </div>
          </div>

          <div className="site-theme-switch" role="group" aria-label="Тема меню">
            <button type="button" className={config.theme_mode === "light" ? "is-active" : ""} onClick={() => chooseTheme("light")}><Sun size={16} />Светлая</button>
            <button type="button" className={config.theme_mode === "dark" ? "is-active" : ""} onClick={() => chooseTheme("dark")}><Moon size={16} />Тёмная</button>
          </div>

          <div className="site-color-fields">
            <label>
              <span>Основной цвет</span>
              <input
                type="color"
                value={config.primary_color}
                onChange={(event) => patchConfig({ primary_color: event.target.value })}
              />
            </label>
            <label>
              <span>Фон</span>
              <input
                type="color"
                value={config.background_color}
                onChange={(event) => patchConfig({ background_color: event.target.value })}
              />
            </label>
            <label><span>Карточки</span><input type="color" value={config.surface_color} onChange={(event) => patchConfig({ surface_color: event.target.value })} /></label>
            <label><span>Текст</span><input type="color" value={config.text_color} onChange={(event) => patchConfig({ text_color: event.target.value })} /></label>
            <label><span>Иконки</span><input type="color" value={config.icon_color} onChange={(event) => patchConfig({ icon_color: event.target.value })} /></label>
          </div>

          <label className="site-font-scale"><span>Размер текста</span><input type="range" min="0.9" max="1.15" step="0.05" value={config.font_scale} onChange={(event) => patchConfig({ font_scale: Number(event.target.value) })} /></label>

          <div className="site-control-group site-media-controls">
            <strong>Изображения</strong>
            <div className="site-background-control">
              <span className="site-background-thumb">{config.background_image_url ? <img src={config.background_image_url} alt="Текущий фон" /> : <ImageIcon size={20} />}</span>
              <label className="site-upload-button"><input type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" disabled={mediaUpload.isPending} onChange={(event) => { const file = event.target.files?.[0]; if (file) mediaUpload.mutate({ kind: "background", file }); event.target.value = ""; }} />{config.background_image_url ? "Заменить фон" : "Загрузить фон"}</label>
              {config.background_image_url && <button type="button" className="site-remove-media" onClick={() => patchConfig({ background_image_url: null })}>Убрать</button>}
            </div>
            {config.background_image_url && <label className="site-overlay-control"><span>Наложение · {config.background_overlay}%</span><input type="range" min="0" max="80" step="5" value={config.background_overlay} onChange={(event) => patchConfig({ background_overlay: Number(event.target.value) })} /></label>}
            <div className="site-media-pair">
              <div>
                <span>Логотип</span>
                {config.logo_url && <img src={config.logo_url} alt="Текущий логотип" />}
                <label className="site-upload-button">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                    disabled={mediaUpload.isPending}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) mediaUpload.mutate({ kind: "logo", file });
                      event.target.value = "";
                    }}
                  />
                  {config.logo_url ? "Заменить" : "Загрузить"}
                </label>
                {config.logo_url && (
                  <button type="button" className="site-remove-media" onClick={() => patchConfig({ logo_url: null })}>
                    Убрать
                  </button>
                )}
              </div>
              <div>
                <span>Обложка</span>
                {config.cover_url && <img src={config.cover_url} alt="Текущая обложка" />}
                <label className="site-upload-button">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                    disabled={mediaUpload.isPending}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) mediaUpload.mutate({ kind: "cover", file });
                      event.target.value = "";
                    }}
                  />
                  {config.cover_url ? "Заменить" : "Загрузить"}
                </label>
                {config.cover_url && (
                  <button type="button" className="site-remove-media" onClick={() => patchConfig({ cover_url: null })}>
                    Убрать
                  </button>
                )}
              </div>
            </div>

            <div className="site-gallery-editor">
              <div>
                <span>Галерея</span>
                <small>{config.gallery_urls.length}/8 фотографий</small>
              </div>
              {config.gallery_urls.length > 0 && (
                <div className="site-gallery-thumbs">
                  {config.gallery_urls.map((url) => (
                    <div key={url}>
                      <img src={url} alt="Фотография галереи" />
                      <button
                        type="button"
                        aria-label="Удалить фотографию"
                        onClick={() =>
                          patchConfig({
                            gallery_urls: config.gallery_urls.filter((item) => item !== url),
                          })
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <label className="site-upload-button site-upload-button--wide">
                <input
                  type="file"
                  accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                  disabled={mediaUpload.isPending || config.gallery_urls.length >= 8}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) mediaUpload.mutate({ kind: "gallery", file });
                    event.target.value = "";
                  }}
                />
                {mediaUpload.isPending ? "Загружаем…" : "+ Добавить фотографию"}
              </label>
            </div>
            <small className="muted">JPG или PNG до 8 МБ. Сервер оптимизирует изображение.</small>
          </div>

          <div className="site-control-group site-content-fields">
            <strong>Содержание</strong>
            <label>
              <span>Подзаголовок на обложке</span>
              <input
                value={config.tagline ?? ""}
                placeholder="Авторская кухня каждый день"
                onChange={(event) => patchConfig({ tagline: event.target.value || null })}
              />
            </label>
            <label>
              <span>Рассказ о ресторане</span>
              <textarea
                rows={4}
                value={config.about ?? ""}
                placeholder={restaurant.description ?? "Расскажите о концепции и кухне"}
                onChange={(event) => patchConfig({ about: event.target.value || null })}
              />
            </label>
            <label>
              <span>Телефон</span>
              <input
                value={config.phone ?? ""}
                placeholder="+7 999 123-45-67"
                onChange={(event) => patchConfig({ phone: event.target.value || null })}
              />
            </label>
            <label>
              <span>Время работы</span>
              <input
                value={config.hours ?? ""}
                placeholder="Ежедневно 10:00–23:00"
                onChange={(event) => patchConfig({ hours: event.target.value || null })}
              />
            </label>
            <label>
              <span>Ссылка на бронирование</span>
              <input
                type="url"
                value={config.booking_url ?? ""}
                placeholder="https://example.com/reserve"
                onChange={(event) => patchConfig({ booking_url: event.target.value || null })}
              />
            </label>
          </div>

          <div className="site-control-group">
            <strong>Порядок блоков</strong>
            <div className="site-block-list">
              {config.blocks.map((block, index) => (
                <div key={block.kind}>
                  <label>
                    <input
                      type="checkbox"
                      checked={block.visible}
                      disabled={block.kind === "menu"}
                      onChange={(event) =>
                        patchConfig({
                          blocks: config.blocks.map((item) =>
                            item.kind === block.kind
                              ? { ...item, visible: event.target.checked }
                              : item,
                          ),
                        })
                      }
                    />
                    <span>{blockNames[block.kind]}</span>
                  </label>
                  <div>
                    <button type="button" disabled={index === 0} onClick={() => moveBlock(index, -1)}>
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={index === config.blocks.length - 1}
                      onClick={() => moveBlock(index, 1)}
                    >
                      ↓
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {mutationError && <div role="alert"><p className="form-error">{mutationError}</p>
            <button type="button" className="button-quiet" onClick={() => {
              const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }));
              const a = document.createElement("a"); a.href = url; a.download = "site-draft-backup.json"; a.click(); URL.revokeObjectURL(url);
            }}>Скачать копию оформления</button>
            <button type="button" className="button-quiet" onClick={async () => {
              if (!window.confirm("Заменить несохранённое оформление актуальным с сервера? Сначала скачайте копию, если она нужна.")) return;
              const result = await site.refetch();
              if (result.data && !result.isError) { setConfig(result.data.config); setRevision(result.data.revision); setSavedConfig(JSON.stringify(result.data.config)); save.reset(); publish.reset(); }
            }}>Загрузить актуальное оформление</button>
          </div>}
          {save.isSuccess && <p className="form-success">Сохранено</p>}
          {publish.isSuccess && <p className="form-success">Оформление опубликовано</p>}
          {!restaurant.current_published_version_id && <p className="muted">Сначала опубликуйте меню, затем оформление.</p>}
          <div className="site-builder-actions">
            <button type="button" className="button-quiet" disabled={save.isPending || publish.isPending || mediaUpload.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Сохраняем…" : "Сохранить черновик"}
            </button>
            <button type="button" disabled={save.isPending || publish.isPending || mediaUpload.isPending || !["owner", "manager"].includes(restaurant.role) || !restaurant.current_published_version_id} onClick={() => publish.mutate()}>
              {publish.isPending ? "Публикуем…" : "Опубликовать оформление"}
            </button>
          </div>
        </fieldset>

        <div className="site-preview-panel">
          <div className="site-preview-toolbar">
            <span />
            <strong>Предпросмотр</strong>
            <small>390 px</small>
          </div>
          <SiteLayout
            config={config}
            restaurant={restaurant}
            preview
            menuContent={
              <MenuPreview sections={menu.data?.sections ?? []} />
            }
          />
        </div>
      </div>
    </details>
  );
}
