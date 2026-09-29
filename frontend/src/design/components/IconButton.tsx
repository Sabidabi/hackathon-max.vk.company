import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> & {
  /** Required: an icon alone does not explain the action. */
  "aria-label": string;
  icon: ReactNode;
  variant?: "plain" | "tonal";
};

/** 44×44 touch target around a Lucide icon. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, variant = "plain", className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={["s-icon-button", `s-icon-button--${variant}`, className].filter(Boolean).join(" ")}
      {...rest}
    >
      <span aria-hidden="true">{icon}</span>
    </button>
  );
});
