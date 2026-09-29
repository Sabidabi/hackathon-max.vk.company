import type { ButtonHTMLAttributes, ReactNode } from "react";

type ChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  selected: boolean;
  icon?: ReactNode;
  children: ReactNode;
};

/**
 * Filter or choice chip (category, milk, size). A toggle button: `aria-pressed` carries the
 * state, so a row of chips reads as a set of independent filters to assistive technology.
 */
export function Chip({ selected, icon, children, className, type = "button", ...rest }: ChipProps) {
  return (
    <button
      type={type}
      aria-pressed={selected}
      className={["s-chip", selected && "s-chip--selected", className].filter(Boolean).join(" ")}
      {...rest}
    >
      {icon && <span className="s-chip__icon" aria-hidden="true">{icon}</span>}
      <span>{children}</span>
    </button>
  );
}
