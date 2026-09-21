import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Sparkles } from "lucide-react";
import { useState } from "react";

import type { DraftMenu } from "../../api/menu";
import {
  applyMenuChange,
  fetchMenuAiStatus,
  planMenuChange,
  type MenuAiProposal,
} from "../../api/menuAi";
import { Modal } from "../../components/Modal";

interface AiMenuComposerProps {
  restaurantId: string;
  revision: string;
  onApplied: (menu: DraftMenu) => void;
  onClose: () => void;
}

const EXAMPLE =
  "Добавь капучино: 300 мл за 190 ₽ и 400 мл за 230 ₽. " +
  "Группа выбора молока обязательная: обычное бесплатно, овсяное +50 ₽.";

function rubles(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: value % 100 === 0 ? 0 : 2,
  }).format(value / 100);
}

export function AiMenuComposer({ restaurantId, revision, onApplied, onClose }: AiMenuComposerProps) {
  const [prompt, setPrompt] = useState(EXAMPLE);
  const [proposal, setProposal] = useState<MenuAiProposal | null>(null);
  const status = useQuery({
    queryKey: ["menu-ai-status", restaurantId],
    queryFn: () => fetchMenuAiStatus(restaurantId),
  });
  const planning = useMutation({
    mutationFn: () => planMenuChange(restaurantId, prompt.trim(), revision),
    onSuccess: setProposal,
  });
  const applying = useMutation({
    mutationFn: () => applyMenuChange(restaurantId, proposal!.proposal_id, revision),
    onSuccess: (menu) => {
      onApplied(menu);
      onClose();
    },
  });

  return (
    <Modal title="Добавить с ИИ" onClose={onClose}>
      <div className="dialog-body ai-composer">
        <p className="muted">Опишите карточки обычными словами. Перед добавлением покажем точный план.</p>
        <label>
          <span>Что создать</span>
          <textarea
            rows={5}
            maxLength={4000}
            value={prompt}
            onChange={(event) => {
              setPrompt(event.target.value);
              setProposal(null);
              planning.reset();
            }}
          />
        </label>
        {status.isSuccess && !status.data.configured && (
          <p className="inline-notice"><AlertTriangle size={16} />Добавьте GIGACHAT_AUTH_KEY на сервере.</p>
        )}
        {planning.isError && <p className="form-error" role="alert">{planning.error.message}</p>}
        {proposal && (
          <div className="ai-plan" aria-label="Предпросмотр изменений">
            <div className="ai-plan-title"><Check size={16} /><strong>{proposal.plan.summary}</strong></div>
            {proposal.plan.warnings.map((warning) => (
              <p className="inline-notice" key={warning}><AlertTriangle size={15} />{warning}</p>
            ))}
            {proposal.plan.operations.map((operation, index) => (
              <article className="ai-plan-card" key={`${operation.section_name}-${operation.item.name}-${index}`}>
                <small>{operation.section_name}</small>
                <strong>{operation.item.name}</strong>
                <span>{rubles(operation.item.base_price_minor)}</span>
                {operation.item.variants.length > 0 && (
                  <p>{operation.item.variants.map((item) => `${item.name} · ${rubles(item.price_minor)}`).join("  /  ")}</p>
                )}
                {operation.item.modifier_groups.map((group) => (
                  <p key={group.name}>
                    {group.name}{group.min_quantity > 0 ? " · обязательно" : ""}: {group.options.map((item) => item.name).join(", ")}
                  </p>
                ))}
              </article>
            ))}
          </div>
        )}
        {applying.isError && <p className="form-error" role="alert">{applying.error.message}</p>}
      </div>
      <footer className="dialog-footer">
        <button type="button" className="button-quiet" onClick={onClose}>Отмена</button>
        {!proposal ? (
          <button
            type="button"
            disabled={!prompt.trim() || planning.isPending || status.isPending || !status.data?.configured}
            onClick={() => planning.mutate()}
          >
            <Sparkles size={16} />{planning.isPending ? "Собираем…" : "Показать план"}
          </button>
        ) : (
          <button type="button" disabled={applying.isPending} onClick={() => applying.mutate()}>
            <Check size={16} />{applying.isPending ? "Добавляем…" : "Добавить в черновик"}
          </button>
        )}
      </footer>
    </Modal>
  );
}
