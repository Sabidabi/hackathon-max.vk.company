import { CircleAlert, CircleCheck } from "lucide-react";
import type { ReactNode } from "react";

export type ToastTone = "neutral" | "success" | "danger";

/**
 * Short status message (`role="status"`, polite). Say what happened: «Изменения сохранены».
 * For messages from non-React code use `showToast` from `design/toast.ts` — same look.
 */
export function Toast({ tone = "neutral", children, action }: { tone?: ToastTone; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`s-toast s-toast--${tone}`} role="status" aria-live="polite">
      {tone === "success" && <CircleCheck size={20} aria-hidden="true" />}
      {tone === "danger" && <CircleAlert size={20} aria-hidden="true" />}
      <span className="s-toast__text">{children}</span>
      {action}
    </div>
  );
}
