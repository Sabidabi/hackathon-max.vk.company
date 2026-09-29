import { useId, type ReactNode } from "react";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** Short explanation under the label (not the only place for critical info). */
  description?: ReactNode;
  disabled?: boolean;
  /** Row control (menu list): only the track is visible, the label stays for screen readers. */
  compact?: boolean;
  /** `aria-busy` while the change is being saved; the switch still shows the new state. */
  busy?: boolean;
}

/** On/off setting with an immediate effect (`role="switch"`), the whole row is the target. */
export function Switch({ checked, onChange, label, description, disabled, compact, busy }: SwitchProps) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy || undefined}
      disabled={disabled}
      className={["s-switch", compact && "s-switch--compact"].filter(Boolean).join(" ")}
      onClick={() => onChange(!checked)}
    >
      <span className={compact ? "s-visually-hidden" : "s-switch__text"}>
        <span id={labelId} className="s-switch__label">{label}</span>
        {description && <span id={descriptionId} className="s-switch__description">{description}</span>}
      </span>
      <span className="s-switch__track" aria-hidden="true"><span className="s-switch__thumb" /></span>
    </button>
  );
}
