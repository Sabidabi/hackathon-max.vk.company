import { Info } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
export function Help({ children, label = "Подробнее" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false); const id = useId(); const root = useRef<HTMLSpanElement>(null);
  useEffect(() => { if (!open) return; const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); }; document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close); }, [open]);
  return <span className="help" ref={root} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
    <button type="button" className="help-button" aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><Info size={16} /></button>
    {open && <span className="help-popover" role="note" id={id}>{children}</span>}
  </span>;
}
