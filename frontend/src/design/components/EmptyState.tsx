import type { ReactNode } from "react";

/** Empty or failed section: icon, what is going on, one way forward. */
export function EmptyState({ icon, title, children, action, tone = "neutral" }: {
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  tone?: "neutral" | "danger";
}) {
  return (
    <section className={`s-empty s-empty--${tone}`}>
      <span className="s-empty__icon" aria-hidden="true">{icon}</span>
      <h2 className="s-empty__title">{title}</h2>
      {children && <p className="s-empty__text">{children}</p>}
      {action && <div className="s-empty__action">{action}</div>}
    </section>
  );
}
