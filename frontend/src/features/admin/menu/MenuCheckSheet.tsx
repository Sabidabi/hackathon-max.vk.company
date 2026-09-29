import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Bird, Camera, CircleCheck, Copy, FileText, FolderX, RotateCcw, Tag } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { checkMenu, type FindingCode, type MenuFinding } from "../../../api/ai";
import { Button, EmptyState, Sheet, Skeleton } from "../../../design";

const GROUPS: Array<{ code: FindingCode; title: string; icon: ReactNode }> = [
  { code: "no_price", title: "Нет цены", icon: <Tag size={18} /> },
  { code: "price_outlier", title: "Подозрительная цена", icon: <AlertTriangle size={18} /> },
  { code: "duplicate_name", title: "Повторы названий", icon: <Copy size={18} /> },
  { code: "empty_section", title: "Пустые разделы", icon: <FolderX size={18} /> },
  { code: "no_description", title: "Без описания", icon: <FileText size={18} /> },
  { code: "no_photo", title: "Без фото", icon: <Camera size={18} /> },
];
const LIMIT = 5;

function FindingGroup({ title, icon, findings, onOpen }: {
  title: string;
  icon: ReactNode;
  findings: MenuFinding[];
  onOpen: (finding: MenuFinding) => void;
}) {
  const [all, setAll] = useState(false);
  const warning = findings[0]?.severity === "warning";
  const shown = all ? findings : findings.slice(0, LIMIT);
  return (
    <section className={`check-group${warning ? " check-group--warning" : ""}`} aria-label={`${title}: ${findings.length}`}>
      <h3><span className="check-group__icon" aria-hidden="true">{icon}</span>{title}<span className="check-group__count">{findings.length}</span></h3>
      <ul>
        {shown.map((finding, index) => (
          <li key={`${finding.item_key ?? finding.section}-${index}`}>
            {finding.item_key ? (
              <button type="button" className="check-row" onClick={() => onOpen(finding)} aria-label={`Открыть «${finding.item_name}»`}>
                <span className="check-row__text">
                  <strong>{finding.item_name}</strong>
                  <small>{finding.code === "price_outlier" || finding.code === "duplicate_name" ? finding.message.replace(`«${finding.item_name}»`, "").replace(/^:\s*/, "").trim() : finding.section}</small>
                  {finding.tip && <span className="check-row__tip">{finding.tip}</span>}
                </span>
              </button>
            ) : (
              <div className="check-row check-row--static">
                <span className="check-row__text">
                  <strong>{finding.section}</strong>
                  {finding.tip ? <span className="check-row__tip">{finding.tip}</span> : <small>Добавьте позиции или удалите раздел</small>}
                </span>
              </div>
            )}
          </li>
        ))}
      </ul>
      {findings.length > LIMIT && (
        <Button variant="ghost" onClick={() => setAll((value) => !value)}>{all ? "Свернуть" : `Ещё ${findings.length - LIMIT}`}</Button>
      )}
    </section>
  );
}

/**
 * «Синица проверила меню» (P1-TASK-42): code checks of the draft — no price, prices ×10 from
 * the section median, duplicates, empty sections, no description or photo — with a short
 * summary and tips from the AI when it is available. Each position opens its card.
 */
export function MenuCheckSheet({ open, menuId, onClose, onOpenItem }: {
  open: boolean;
  menuId: string;
  onClose: () => void;
  onOpenItem: (itemKey: string) => void;
}) {
  const check = useMutation({ mutationFn: () => checkMenu(menuId) });
  const { mutate, reset } = check;
  useEffect(() => {
    if (open) mutate();
    else reset();
  }, [open, menuId, mutate, reset]);

  const data = check.data;
  const warnings = data?.findings.filter((finding) => finding.severity === "warning").length ?? 0;
  return (
    <Sheet open={open} onClose={onClose} title="Синица проверила меню">
      <div className="check" aria-busy={check.isPending}>
        {check.isPending && (
          <div className="check-loading" aria-label="Проверяем меню">
            <Skeleton height={56} radius="control" />
            {[0, 1, 2, 3].map((row) => <Skeleton key={row} height={44} radius="control" />)}
          </div>
        )}
        {check.isError && (
          <EmptyState icon={<AlertTriangle size={28} />} tone="danger" title="Не удалось проверить меню" action={<Button icon={<RotateCcw size={20} />} onClick={() => mutate()}>Попробовать снова</Button>}>
            {check.error.message}
          </EmptyState>
        )}
        {data && (
          data.findings.length ? (
            <>
              <div className="check-summary">
                <span className="check-summary__bird" aria-hidden="true"><Bird size={18} /></span>
                <div>
                  <p className="check-summary__lead">
                    {warnings ? `Исправьте ${warnings} — гости это заметят` : "Критичного нет — можно сделать меню аппетитнее"}
                    {data.provider === "mock" && <span className="check-demo">Демо-ИИ</span>}
                  </p>
                  {data.summary && <p className="check-summary__ai" data-testid="check-summary">{data.summary}</p>}
                  {data.ai === "unavailable" && <p className="check-summary__note">ИИ сейчас недоступен — показываем проверки без подсказок.</p>}
                  {data.ai === "limit" && <p className="check-summary__note">Лимит ИИ на сегодня исчерпан — показываем проверки без подсказок.</p>}
                </div>
              </div>
              {GROUPS.map((group) => {
                const findings = data.findings.filter((finding) => finding.code === group.code);
                return findings.length ? (
                  <FindingGroup key={group.code} title={group.title} icon={group.icon} findings={findings} onOpen={(finding) => finding.item_key && onOpenItem(finding.item_key)} />
                ) : null;
              })}
            </>
          ) : (
            <EmptyState icon={<CircleCheck size={28} />} title="Всё в порядке">
              Цены, названия и разделы без замечаний.
            </EmptyState>
          )
        )}
      </div>
    </Sheet>
  );
}
