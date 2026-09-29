import { Check } from "lucide-react";
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";

import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonOwnProps {
  variant?: ButtonVariant;
  /** Shows a spinner, keeps the width and blocks repeated clicks until the server answers. */
  loading?: boolean;
  /** Leading Lucide icon. */
  icon?: ReactNode;
  fullWidth?: boolean;
  /**
   * Morph «кнопка → прогресс → галочка»: `progress` swaps the label
   * for a spinner and blocks clicks, `success` shows a check on the success colour. The label
   * stays in the layout, so the button keeps its size.
   */
  status?: "idle" | "progress" | "success";
  children: ReactNode;
}

type ButtonProps = ButtonOwnProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">;
type ButtonLinkProps = ButtonOwnProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children"> & { href: string };

function classes(variant: ButtonVariant, fullWidth: boolean | undefined, loading: boolean | undefined, status: ButtonOwnProps["status"], extra?: string) {
  return [
    "s-button",
    `s-button--${variant}`,
    fullWidth && "s-button--full",
    (loading || status === "progress") && "s-button--loading",
    status && status !== "idle" && "s-button--morph",
    status === "success" && "s-button--success",
    extra,
  ]
    .filter(Boolean)
    .join(" ");
}

function Content({ icon, loading, status, children }: Pick<ButtonOwnProps, "icon" | "loading" | "status" | "children">) {
  return (
    <>
      <span className="s-button__content">
        {loading ? <Spinner size={18} className="s-button__icon" /> : icon && <span className="s-button__icon" aria-hidden="true">{icon}</span>}
        <span className="s-button__label">{children}</span>
      </span>
      {status === "progress" && <span className="s-button__status"><Spinner size={20} /></span>}
      {status === "success" && <span className="s-button__status" aria-hidden="true"><Check size={22} strokeWidth={2.5} /></span>}
    </>
  );
}

/** Main action button. The label names the result: «Опубликовать», «Сохранить». */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", loading, icon, fullWidth, status, className, children, disabled, type = "button", ...rest },
  ref,
) {
  const busy = loading || status === "progress";
  return (
    <button
      ref={ref}
      type={type}
      className={classes(variant, fullWidth, loading, status, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      <Content icon={icon} loading={loading} status={status}>{children}</Content>
    </button>
  );
});

/** A link that looks like a button (deep links, external pages). */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  { variant = "primary", loading, icon, fullWidth, status, className, children, ...rest },
  ref,
) {
  return (
    <a ref={ref} className={classes(variant, fullWidth, loading, status, className)} {...rest}>
      <Content icon={icon} loading={loading} status={status}>{children}</Content>
    </a>
  );
});
