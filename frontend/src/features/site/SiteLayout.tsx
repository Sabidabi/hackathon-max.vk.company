import type { CSSProperties, ReactNode } from "react";

import type { SiteConfig } from "../../api/site";

interface SiteRestaurant {
  name: string;
  description: string | null;
  address: string | null;
}

export function SiteLayout({
  config,
  restaurant,
  menuContent,
  preview = false,
}: {
  config: SiteConfig;
  restaurant: SiteRestaurant;
  menuContent: ReactNode;
  preview?: boolean;
}) {
  const style = {
    "--site-primary": config.primary_color,
    "--site-background": config.background_color,
    "--site-surface": config.surface_color,
    "--site-text": config.text_color,
    "--site-icon": config.icon_color,
    "--site-font-scale": config.font_scale,
    "--site-background-image": config.background_image_url
      ? `url(${config.background_image_url})`
      : "none",
    "--site-background-overlay": config.theme_mode === "dark"
      ? `rgba(0, 0, 0, ${config.background_overlay / 100})`
      : `rgba(255, 255, 255, ${config.background_overlay / 100})`,
  } as CSSProperties;
  const blockTitles = {
    hero: null,
    about: "О ресторане",
    menu: "Меню",
    gallery: "Галерея",
    contacts: "Контакты",
  };

  return (
    <div
      className={`site-layout site-template--${config.template} site-theme--${config.theme_mode}${preview ? " site-layout--preview" : ""}`}
      style={style}
    >
      {config.blocks
        .filter((block) => block.visible)
        .map((block) => {
          const title = block.title ?? blockTitles[block.kind];
          if (block.kind === "hero") {
            const heroStyle = config.cover_url
              ? ({ "--site-cover-image": `url(${config.cover_url})` } as CSSProperties)
              : undefined;
            return (
              <header
                className={`site-hero${config.cover_url ? " site-hero--with-cover" : ""}`}
                key={block.kind}
                style={heroStyle}
              >
                {config.logo_url && <img className="site-logo" src={config.logo_url} alt="" />}
                <span className="site-eyebrow">Ресторан</span>
                <h1>{restaurant.name}</h1>
                {(config.tagline || restaurant.description) && (
                  <p>{config.tagline || restaurant.description}</p>
                )}
              </header>
            );
          }
          if (block.kind === "about") {
            const description = config.about || restaurant.description;
            return description ? (
              <section className="site-content-block" key={block.kind}>
                <span className="site-block-number">01</span>
                {title && <h2>{title}</h2>}
                <p>{description}</p>
              </section>
            ) : null;
          }
          if (block.kind === "menu") {
            return (
              <section className="site-menu-block" key={block.kind}>
                {title && <h2>{title}</h2>}
                {menuContent}
              </section>
            );
          }
          if (block.kind === "gallery") {
            return config.gallery_urls.length ? (
              <section className="site-content-block site-gallery-block" key={block.kind}>
                {title && <h2>{title}</h2>}
                <div className="site-gallery">
                  {config.gallery_urls.map((url, index) => (
                    <img src={url} alt={`Фотография ресторана ${index + 1}`} key={url} />
                  ))}
                </div>
              </section>
            ) : null;
          }
          return (
            <section className="site-content-block site-contacts" key={block.kind}>
              <span className="site-block-number">02</span>
              {title && <h2>{title}</h2>}
              <div className="site-contact-grid">
                {restaurant.address && (
                  <div>
                    <small>Адрес</small>
                    <span>{restaurant.address}</span>
                  </div>
                )}
                {config.phone && (
                  <div>
                    <small>Телефон</small>
                    <a href={`tel:${config.phone.replace(/[^+\d]/g, "")}`}>{config.phone}</a>
                  </div>
                )}
                {config.hours && (
                  <div>
                    <small>Время работы</small>
                    <span>{config.hours}</span>
                  </div>
                )}
              </div>
              {config.booking_url && (
                <a
                  className="site-booking-button"
                  href={config.booking_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Забронировать стол
                </a>
              )}
            </section>
          );
        })}
      <footer className="site-footer">Меню обновляется рестораном</footer>
    </div>
  );
}
