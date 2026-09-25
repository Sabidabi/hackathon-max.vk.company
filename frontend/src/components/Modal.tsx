import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
export function Modal({ title, children, cover, onClose, className = "" }: { title: string; children: ReactNode; cover?: ReactNode; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null); const id = useId();
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className={`product-dialog ${className}`.trim()} aria-labelledby={id} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    {cover}
    <header className="dialog-header"><h2 id={id}>{title}</h2><button type="button" className="icon-button" aria-label="Закрыть карточку" onClick={onClose}><X size={20} /></button></header>
    {children}
  </dialog>;
}
