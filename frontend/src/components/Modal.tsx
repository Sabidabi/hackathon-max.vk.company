import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null); const id = useId();
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="product-dialog" aria-labelledby={id} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="dialog-header"><h2 id={id}>{title}</h2><button type="button" className="icon-button" aria-label="Закрыть карточку" onClick={onClose}><X size={20} /></button></header>
    {children}
  </dialog>;
}
