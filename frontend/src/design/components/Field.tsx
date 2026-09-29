import { ChevronDown } from "lucide-react";

import { haptics } from "../../max/platform";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

export interface FieldControlProps {
  id: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  "aria-required"?: boolean;
}

interface FieldProps {
  label: ReactNode;
  /** Explains a requirement next to the field (P1-DOC-3: не прятать в иконку i). */
  hint?: ReactNode;
  /** Visible error text; the control gets `aria-invalid` and points to it. */
  error?: ReactNode;
  required?: boolean;
  id?: string;
  children: (control: FieldControlProps) => ReactNode;
}

/** Label + control + hint + error. The control is rendered by `children` with wired ids. */
export function Field({ label, hint, error, required, id, children }: FieldProps) {
  const autoId = useId();
  const controlId = id ?? `field${autoId}`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const describedBy = [hint && hintId, error && errorId].filter(Boolean).join(" ") || undefined;
  // A new error: the control shakes (CSS) and MAX gives an error haptic (P1-DOC-18).
  const hadError = useRef(Boolean(error));
  useEffect(() => {
    if (error && !hadError.current) haptics.notify("error");
    hadError.current = Boolean(error);
  }, [error]);
  return (
    <div className={["s-field", error && "s-field--invalid"].filter(Boolean).join(" ")}>
      <label className="s-field__label" htmlFor={controlId}>
        {label}
        {required && <span className="s-field__required"> (обязательно)</span>}
      </label>
      {children({
        id: controlId,
        "aria-invalid": error ? true : undefined,
        "aria-describedby": describedBy,
        "aria-required": required || undefined,
      })}
      {hint && <p id={hintId} className="s-field__hint">{hint}</p>}
      {error && <p id={errorId} className="s-field__error" role="alert">{error}</p>}
    </div>
  );
}

type Common = { label: ReactNode; hint?: ReactNode; error?: ReactNode };

export const TextInput = forwardRef<HTMLInputElement, Common & Omit<InputHTMLAttributes<HTMLInputElement>, "children">>(
  function TextInput({ label, hint, error, required, id, className, ...rest }, ref) {
    return (
      <Field label={label} hint={hint} error={error} required={required} id={id}>
        {(control) => <input ref={ref} className={["s-input", className].filter(Boolean).join(" ")} required={required} {...control} {...rest} />}
      </Field>
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, Common & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "children">>(
  function Textarea({ label, hint, error, required, id, className, rows = 4, ...rest }, ref) {
    return (
      <Field label={label} hint={hint} error={error} required={required} id={id}>
        {(control) => <textarea ref={ref} rows={rows} className={["s-input", "s-input--multiline", className].filter(Boolean).join(" ")} required={required} {...control} {...rest} />}
      </Field>
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, Common & SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ label, hint, error, required, id, className, children, ...rest }, ref) {
    return (
      <Field label={label} hint={hint} error={error} required={required} id={id}>
        {(control) => (
          <span className="s-select">
            <select ref={ref} className={["s-input", "s-select__control", className].filter(Boolean).join(" ")} required={required} {...control} {...rest}>
              {children}
            </select>
            <ChevronDown className="s-select__chevron" size={20} aria-hidden="true" />
          </span>
        )}
      </Field>
    );
  },
);
