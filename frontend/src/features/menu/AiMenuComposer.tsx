import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Sparkles } from "lucide-react";
import { useState } from "react";

import { trackAdmin } from "../../analytics";
import type { DraftMenu } from "../../api/menu";
import { applyMenuChange, fetchMenuAiStatus, planMenuChange, type MenuAiProposal } from "../../api/menuAi";
import { Button, Sheet, Skeleton, Textarea } from "../../design";
import { haptics } from "../../max";
import "./ai-composer.css";

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

/**
 * «Описать словами» (P1-DOC-8): the admin describes positions, the server returns a typed
 * plan, the admin sees exactly what will be added and applies it to the draft. Without the
 * AI key the sheet says so and the menu stays editable by hand.
 */
export function AiMenuComposer({ restaurantId, revision, onApplied, onClose }: AiMenuComposerProps) {
  const [prompt, setPrompt] = useState(EXAMPLE);
  const [proposal, setProposal] = useState<MenuAiProposal | null>(null);
  const status = useQuery({
    queryKey: ["menu-ai-status", restaurantId],
    queryFn: () => fetchMenuAiStatus(restaurantId),
  });
  const planning = useMutation({
    mutationFn: () => planMenuChange(restaurantId, prompt.trim(), revision),
    onSuccess: (result) => {
      haptics.notify("success");
      setProposal(result);
    },
    onError: () => haptics.notify("error"),
  });
  const applying = useMutation({
    mutationFn: () => applyMenuChange(restaurantId, proposal!.proposal_id, revision),
    onSuccess: (menu) => {
      haptics.notify("success");
      trackAdmin("ai_plan_applied");
      onApplied(menu);
      onClose();
    },
  });
  const unavailable = status.isSuccess && !status.data.configured;

  return (
    <Sheet
      open
      onClose={onClose}
      title="Добавить с ИИ"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          {!proposal ? (
            <Button
              icon={<Sparkles size={20} />}
              loading={planning.isPending}
              disabled={!prompt.trim() || status.isPending || unavailable}
              onClick={() => planning.mutate()}
            >
              Показать план
            </Button>
          ) : (
            <Button icon={<Check size={20} />} loading={applying.isPending} onClick={() => applying.mutate()}>Добавить в черновик</Button>
          )}
        </>
      )}
    >
      <div className="ai-composer">
        <p className="cabinet-muted">Опишите позиции обычными словами. Перед добавлением покажем точный план — цены, размеры и добавки.</p>
        <Textarea
          label="Что добавить"
          rows={5}
          maxLength={4000}
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
            setProposal(null);
            planning.reset();
          }}
        />
        {unavailable && (
          <p className="ai-composer__notice" role="status"><AlertTriangle size={18} aria-hidden="true" />ИИ сейчас недоступен — добавьте позицию вручную.</p>
        )}
        {planning.isError && <p className="cabinet-error" role="alert">{planning.error.message}</p>}
        {planning.isPending && <Skeleton height={96} radius="card" />}
        {proposal && (
          <section className="ai-plan" aria-label="Предпросмотр изменений">
            <p className="ai-plan__title"><Check size={18} aria-hidden="true" /><strong>{proposal.plan.summary}</strong></p>
            {proposal.plan.warnings.map((warning) => (
              <p className="ai-composer__notice" key={warning}><AlertTriangle size={16} aria-hidden="true" />{warning}</p>
            ))}
            {proposal.plan.operations.map((operation, index) => (
              <article className="ai-plan__card" key={`${operation.section_name}-${operation.item.name}-${index}`}>
                <small>{operation.section_name}</small>
                <strong>{operation.item.name}</strong>
                <span className="ai-plan__price">{rubles(operation.item.base_price_minor)}</span>
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
          </section>
        )}
        {applying.isError && <p className="cabinet-error" role="alert">{applying.error.message}</p>}
      </div>
    </Sheet>
  );
}
